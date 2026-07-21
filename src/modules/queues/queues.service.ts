import { BadRequestException, Injectable, InternalServerErrorException } from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";

// Posting queues — SocialPilot's signature feature. Each account has a weekly
// grid of time slots (weekday 0-6 + time). "Add to queue" schedules a post
// into the earliest future slot that isn't already occupied.
//
// Slot times are interpreted in the WORKSPACE timezone (app_settings.timezone,
// falling back to UTC) so "Mon 09:00" means 9am where the team works, not
// wherever the server happens to run.

const OCCUPIED_WINDOW_MS = 30 * 60 * 1000; // a slot within ±30min of an existing post is taken
const MIN_LEAD_MS = 15 * 60 * 1000;        // never queue closer than 15 minutes out
const SEARCH_DAYS = 14;

@Injectable()
export class QueuesService {
  constructor(private readonly supabaseService: SupabaseService) {}

  private async workspaceTimezone(): Promise<string> {
    const supabase = this.supabaseService.createServiceClient();
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("user_id", OWNER_ID)
      .eq("key", "app")
      .maybeSingle();
    return data?.value?.timezone || "UTC";
  }

  // "2026-07-21" + "09:30" in an IANA timezone → UTC Date. Two-pass offset
  // trick — no tz library needed, accurate across DST for practical purposes.
  private zonedToUtc(dateStr: string, timeStr: string, timeZone: string): Date {
    const guess = new Date(`${dateStr}T${timeStr}:00Z`);
    const inTz = new Date(guess.toLocaleString("en-US", { timeZone }));
    const inUtc = new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
    return new Date(guess.getTime() + (inUtc.getTime() - inTz.getTime()));
  }

  // Calendar date (YYYY-MM-DD) of now+N days in the given timezone.
  private dateInTz(daysFromNow: number, timeZone: string): string {
    const d = new Date(Date.now() + daysFromNow * 86400000);
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  }

  async list() {
    const supabase = this.supabaseService.createServiceClient();
    const { data, error } = await supabase
      .from("posting_slots")
      .select("*")
      .eq("user_id", OWNER_ID)
      .order("weekday", { ascending: true })
      .order("time_of_day", { ascending: true });
    if (error) throw new InternalServerErrorException(error.message);
    return { slots: data || [], timezone: await this.workspaceTimezone() };
  }

  // Replace an account's entire weekly grid in one call (how the editor saves).
  async replaceForAccount(accountId: string, slots: any[]) {
    if (!accountId) throw new BadRequestException("accountId is required.");
    const clean = (Array.isArray(slots) ? slots : [])
      .map((s) => ({
        weekday: Number(s.weekday),
        time_of_day: String(s.time || s.time_of_day || "").slice(0, 5),
      }))
      .filter((s) => s.weekday >= 0 && s.weekday <= 6 && /^\d{2}:\d{2}$/.test(s.time_of_day));

    const supabase = this.supabaseService.createServiceClient();
    const { error: delError } = await supabase
      .from("posting_slots")
      .delete()
      .eq("user_id", OWNER_ID)
      .eq("social_account_id", accountId);
    if (delError) throw new InternalServerErrorException(delError.message);

    if (clean.length) {
      const { error: insError } = await supabase.from("posting_slots").insert(
        clean.map((s) => ({ user_id: OWNER_ID, social_account_id: accountId, ...s })),
      );
      if (insError) throw new InternalServerErrorException(insError.message);
    }
    return this.list();
  }

  // Earliest future slot across the given accounts that isn't occupied.
  // Returns an ISO timestamp for scheduled_for.
  async nextOpenSlot(accountIds: string[]): Promise<string> {
    if (!accountIds?.length) throw new BadRequestException("No accounts selected.");
    const supabase = this.supabaseService.createServiceClient();
    const timeZone = await this.workspaceTimezone();

    const { data: slots, error } = await supabase
      .from("posting_slots")
      .select("weekday, time_of_day")
      .eq("user_id", OWNER_ID)
      .in("social_account_id", accountIds);
    if (error) throw new InternalServerErrorException(error.message);
    if (!slots?.length) {
      throw new BadRequestException(
        "No queue slots configured for the selected accounts — set them up under Settings → Posting Queue.",
      );
    }

    // Existing upcoming posts for these accounts = occupied times.
    const { data: upcoming } = await supabase
      .from("post_targets")
      .select("scheduled_posts(scheduled_for, status)")
      .in("social_account_id", accountIds);
    const occupied = (upcoming || [])
      .map((t: any) => t.scheduled_posts)
      .filter((p: any) => p && ["scheduled", "publishing", "pending_review", "approved"].includes(p.status))
      .map((p: any) => new Date(p.scheduled_for).getTime())
      .filter((t: number) => t > Date.now() - OCCUPIED_WINDOW_MS);

    const earliest = Date.now() + MIN_LEAD_MS;
    for (let day = 0; day <= SEARCH_DAYS; day++) {
      const dateStr = this.dateInTz(day, timeZone);
      // Parsing YYYY-MM-DD as UTC midnight gives that calendar date's weekday.
      const weekday = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
      const daySlots = slots
        .filter((s) => Number(s.weekday) === weekday)
        .sort((a, b) => String(a.time_of_day).localeCompare(String(b.time_of_day)));

      for (const slot of daySlots) {
        const candidate = this.zonedToUtc(dateStr, String(slot.time_of_day).slice(0, 5), timeZone);
        if (candidate.getTime() < earliest) continue;
        const taken = occupied.some((t) => Math.abs(t - candidate.getTime()) < OCCUPIED_WINDOW_MS);
        if (!taken) return candidate.toISOString();
      }
    }
    throw new BadRequestException(
      `Every queue slot in the next ${SEARCH_DAYS} days is taken — add more slots or pick a time manually.`,
    );
  }

  // Best posting times derived from historical engagement: buckets every
  // synced insight by (weekday, hour) in the workspace timezone and ranks by
  // average engagement.
  async bestTimes(accountId?: string) {
    const supabase = this.supabaseService.createServiceClient();
    const timeZone = await this.workspaceTimezone();

    let q = supabase
      .from("post_insights")
      .select("likes, comments, shares, post_targets(sent_at, social_account_id)")
      .limit(500);
    const { data, error } = await q;
    if (error) throw new InternalServerErrorException(error.message);

    const buckets = new Map<string, { weekday: number; hour: number; total: number; count: number }>();
    const fmt = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", hour12: false });

    for (const row of data || []) {
      const t: any = row.post_targets;
      if (!t?.sent_at) continue;
      if (accountId && t.social_account_id !== accountId) continue;

      const parts = fmt.formatToParts(new Date(t.sent_at));
      const weekdayName = parts.find((p) => p.type === "weekday")?.value || "Sun";
      const hour = Number(parts.find((p) => p.type === "hour")?.value || 0) % 24;
      const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(weekdayName);

      const key = `${weekday}-${hour}`;
      const bucket = buckets.get(key) || { weekday, hour, total: 0, count: 0 };
      bucket.total += (row.likes || 0) + (row.comments || 0) + (row.shares || 0);
      bucket.count += 1;
      buckets.set(key, bucket);
    }

    const suggestions = [...buckets.values()]
      .map((b) => ({ weekday: b.weekday, hour: b.hour, avgEngagement: +(b.total / b.count).toFixed(1), samples: b.count }))
      .sort((a, b) => b.avgEngagement - a.avgEngagement)
      .slice(0, 5);

    return { suggestions, timezone: timeZone };
  }
}
