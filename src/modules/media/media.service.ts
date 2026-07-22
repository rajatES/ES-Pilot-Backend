import { BadRequestException, Injectable, InternalServerErrorException } from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { StorageService } from "../../storage/storage.service";

@Injectable()
export class MediaService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly storage: StorageService,
  ) {}

  async list(filters: { folderId?: string; tag?: string; favorite?: string; q?: string }) {
    const supabase = this.supabaseService.createServiceClient();
    const { folderId, tag, favorite, q } = filters;
    const favoritesOnly = favorite === "1";

    let query = supabase
      .from("media_assets")
      .select("*")
      .eq("user_id", OWNER_ID)
      .order("created_at", { ascending: false });
    if (folderId) query = query.eq("folder_id", folderId);
    if (tag) query = query.contains("tags", [tag]);
    if (favoritesOnly) query = query.eq("is_favorite", true);
    if (q) query = query.ilike("filename", `%${q}%`);

    const { data, error } = await query;
    if (error) throw new InternalServerErrorException(error.message);
    return { assets: data };
  }

  // Register a media asset (after upload, or a pasted URL). Dedupes by hash.
  async create(payload: any) {
    const supabase = this.supabaseService.createServiceClient();
    const { url, storagePath, filename, mimeType, sizeBytes, hash, source, folderId } = payload || {};

    if (!url) throw new BadRequestException("url is required.");

    if (hash) {
      const { data: existing } = await supabase
        .from("media_assets")
        .select("*")
        .eq("user_id", OWNER_ID)
        .eq("hash", hash)
        .maybeSingle();
      if (existing) return { asset: existing, deduped: true };
    }

    const { data: row, error } = await supabase
      .from("media_assets")
      .insert({
        user_id: OWNER_ID,
        url,
        storage_path: storagePath || null,
        filename: filename || null,
        mime_type: mimeType || null,
        size_bytes: sizeBytes || null,
        hash: hash || null,
        source: source || "upload",
        folder_id: folderId || null,
      })
      .select()
      .single();

    if (error) throw new InternalServerErrorException(error.message);
    return { asset: row };
  }

  async update(id: string, payload: any) {
    const supabase = this.supabaseService.createServiceClient();
    const { tags, isFavorite, folderId, markUsed } = payload || {};

    const update: any = {};
    if (tags !== undefined) update.tags = tags;
    if (isFavorite !== undefined) update.is_favorite = isFavorite;
    if (folderId !== undefined) update.folder_id = folderId || null;
    if (markUsed) {
      update.last_used_at = new Date().toISOString();
    }

    if (markUsed) {
      const { data: current } = await supabase
        .from("media_assets")
        .select("used_count")
        .eq("id", id)
        .eq("user_id", OWNER_ID)
        .single();
      update.used_count = (current?.used_count || 0) + 1;
    }

    const { data: row, error } = await supabase
      .from("media_assets")
      .update(update)
      .eq("id", id)
      .eq("user_id", OWNER_ID)
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    return { asset: row };
  }

  async remove(id: string) {
    const supabase = this.supabaseService.createServiceClient();
    // delete().select() returns the removed row so we can also drop the S3
    // object (uploaded assets only; external/source assets have no key).
    const { data, error } = await supabase
      .from("media_assets")
      .delete()
      .eq("id", id)
      .eq("user_id", OWNER_ID)
      .select()
      .maybeSingle();
    if (error) throw new InternalServerErrorException(error.message);
    if (data?.storage_path) await this.storage.remove(data.storage_path);
    return { ok: true };
  }

  async listFolders() {
    const supabase = this.supabaseService.createServiceClient();
    const { data, error } = await supabase
      .from("media_folders")
      .select("*")
      .eq("user_id", OWNER_ID)
      .order("name", { ascending: true });
    if (error) throw new InternalServerErrorException(error.message);
    return { folders: data };
  }

  async createFolder(payload: any) {
    const supabase = this.supabaseService.createServiceClient();
    const { name, parentId } = payload || {};
    if (!name?.trim()) throw new BadRequestException("Folder name is required.");
    const { data: row, error } = await supabase
      .from("media_folders")
      .insert({ user_id: OWNER_ID, name: name.trim(), parent_id: parentId || null })
      .select()
      .single();
    if (error) throw new InternalServerErrorException(error.message);
    return { folder: row };
  }
}
