import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcrypt";
import * as jwt from "jsonwebtoken";
import { SupabaseService } from "../supabase/supabase.service";

// User management and JWT sessions. Users live in the profiles table
// (bcrypt password_hash). Login issues a signed JWT the frontend sends as
// a Bearer header; JwtAuthGuard verifies it.
@Injectable()
export class AuthCoreService {
  constructor(private readonly supabaseService: SupabaseService) {}

  private get secret(): string {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error("JWT_SECRET is not set");
    return s;
  }

  private get ttl(): string {
    return process.env.JWT_EXPIRES_IN || "30d";
  }

  issueToken(profile: any): string {
    return jwt.sign(
      { sub: profile.id, email: profile.email, role: profile.role },
      this.secret,
      { expiresIn: this.ttl } as jwt.SignOptions,
    );
  }

  // Returns the token payload, or null if the token is missing/invalid/expired.
  verifyToken(token: string): { sub: string; email: string; role: string } | null {
    if (!token) return null;
    try {
      return jwt.verify(token, this.secret) as any;
    } catch {
      return null;
    }
  }

  async findProfileById(id: string) {
    if (!id) return null;
    const db = this.supabaseService.createServiceClient();
    const { data } = await db.from("profiles").select("*").eq("id", id).maybeSingle();
    return data || null;
  }

  async emailExists(email: string): Promise<boolean> {
    const db = this.supabaseService.createServiceClient();
    const { data } = await db.from("profiles").select("id").ilike("email", email.trim()).maybeSingle();
    return !!data;
  }

  // Create a user row with a bcrypt-hashed password. Throws on duplicate email.
  async createUser(fields: {
    email: string;
    password: string;
    displayName: string;
    role?: string;
    divisionId?: string | null;
    isGroupHead?: boolean;
    status?: string;
  }) {
    const email = fields.email.trim();
    if (await this.emailExists(email)) {
      throw new BadRequestException("A user with this email already exists.");
    }
    const password_hash = await bcrypt.hash(fields.password, 10);
    const db = this.supabaseService.createServiceClient();
    const { data, error } = await db
      .from("profiles")
      .insert({
        email,
        password_hash,
        display_name: fields.displayName.trim(),
        role: fields.role || "member",
        division_id: fields.divisionId || null,
        is_group_head: !!fields.isGroupHead,
        status: fields.status || "active",
      })
      .select()
      .single();
    if (error) throw new BadRequestException(error.message);
    if (data) delete data.password_hash; // never return the hash to callers
    return data;
  }

  async deleteUser(id: string) {
    const db = this.supabaseService.createServiceClient();
    await db.from("profiles").delete().eq("id", id);
    return { ok: true };
  }

  async setPassword(id: string, password: string) {
    const password_hash = await bcrypt.hash(password, 10);
    const db = this.supabaseService.createServiceClient();
    await db.from("profiles").update({ password_hash }).eq("id", id);
    return { ok: true };
  }

  // Verify credentials and mint a token. Pending seats can authenticate;
  // the app shows a waiting-for-approval screen.
  async login(email: string, password: string) {
    if (!email?.trim() || !password) {
      throw new BadRequestException("Email and password are required.");
    }
    const db = this.supabaseService.createServiceClient();
    const { data: profile } = await db
      .from("profiles")
      .select("*")
      .ilike("email", email.trim())
      .maybeSingle();

    if (!profile || !profile.password_hash) {
      throw new UnauthorizedException("Invalid email or password.");
    }
    const ok = await bcrypt.compare(password, profile.password_hash);
    if (!ok) throw new UnauthorizedException("Invalid email or password.");

    const token = this.issueToken(profile);
    delete profile.password_hash;
    return { token, profile };
  }
}
