import { BadRequestException, Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { SupabaseService, OWNER_ID } from "../../supabase/supabase.service";
import { publishFacebookPost, publishFacebookReel, publishFacebookStory, postFacebookComment } from "../../lib/facebook";
import { publishInstagramPost, postInstagramComment } from "../../lib/instagram";
import { publishThreadsPost, postThreadsReply } from "../../lib/threads";
import { publishXPost, postXReply } from "../../lib/x";
import { publishYouTubeVideo } from "../../lib/youtube";
import { logActivity } from "../../lib/activity";
import { appendUtm, utmTrackingEnabled } from "../../lib/utm";
import { runCompliance } from "../../lib/compliance";
import {
  postForPlatform,
  platformOptions,
  fbFormat,
  sanitizePlatformCaptions,
  sanitizePlatformOptions,
} from "../../lib/postContent";

@Injectable()
export class PublishNowService {
  constructor(private readonly supabaseService: SupabaseService) {}

  async publish(payload: any, author: any) {
    const supabase = this.supabaseService.createServiceClient();

    const { body, imageUrl, media, linkUrl, socialAccountIds, firstComment, contentType, templateId } = payload || {};
    const pCaptions = sanitizePlatformCaptions(payload?.platformCaptions);
    const pOptions = sanitizePlatformOptions(payload?.platformOptions);

    if (!body?.trim() || !socialAccountIds?.length) {
      throw new BadRequestException("Post text and at least one Page are required.");
    }

    // Ordered media list — imageUrl is the legacy single-image field.
    const mediaList = (Array.isArray(media) ? media : [])
      .filter((m: any) => m?.url)
      .map((m: any) => ({ url: m.url, type: m.type === "video" ? "video" : "image" }));
    if (!mediaList.length && imageUrl) mediaList.push({ url: imageUrl, type: "image" });
    const firstImage = mediaList.find((m) => m.type === "image")?.url || null;

    const { data: accounts, error: accountsError } = await supabase
      .from("social_accounts")
      .select("*")
      .in("id", socialAccountIds)
      .eq("user_id", OWNER_ID);

    if (accountsError || !accounts?.length) {
      throw new NotFoundException("Selected accounts not found.");
    }

    if (!mediaList.length && accounts.some((a) => a.platform === "instagram")) {
      throw new BadRequestException("Instagram posts require an image or video — attach media or deselect the Instagram account.");
    }
    if (!mediaList.some((m) => m.type === "video") && accounts.some((a) => a.platform === "youtube")) {
      throw new BadRequestException("YouTube posts require a video — attach one or deselect the YouTube channel.");
    }
    // Facebook Reel/Story media requirements (format from platform_options).
    if (accounts.some((a) => a.platform === "facebook")) {
      const fbFmt = pOptions?.facebook?.format || "post";
      const videoCount = mediaList.filter((m) => m.type === "video").length;
      if (fbFmt === "reel" && (videoCount !== 1 || mediaList.length !== 1)) {
        throw new BadRequestException("A Facebook Reel needs exactly one video (no images).");
      }
      if (fbFmt === "story" && mediaList.length !== 1) {
        throw new BadRequestException("A Facebook Story needs exactly one image or video.");
      }
    }

    // Compliance is advisory only — flags shown in UI but never block publishing.
    runCompliance({ body, linkUrl, imageUrl: firstImage, contentType, accounts });

    const now = new Date().toISOString();

    const { data: post, error: postError } = await supabase
      .from("scheduled_posts")
      .insert({
        user_id: OWNER_ID,
        body: body.trim(),
        image_url: firstImage,
        media: mediaList.length ? mediaList : null,
        link_url: linkUrl || null,
        first_comment: firstComment || null,
        content_type: contentType || null,
        template_id: templateId || null,
        platform_captions: pCaptions,
        platform_options: pOptions,
        created_by: author?.id || null,
        scheduled_for: now,
        status: "publishing",
      })
      .select()
      .single();

    if (postError) throw new InternalServerErrorException(postError.message);

    // UTM click tracking (opt-in via Settings).
    let outboundLink = linkUrl || null;
    if (outboundLink && (await utmTrackingEnabled())) {
      outboundLink = appendUtm(outboundLink, { postId: post.id });
      await supabase.from("scheduled_posts").update({ link_url: outboundLink }).eq("id", post.id);
    }

    const results: any[] = [];

    for (const account of accounts) {
      const { error: targetError } = await supabase.from("post_targets").insert({
        post_id: post.id,
        social_account_id: account.id,
        platform: account.platform,
        status: "publishing",
      });

      if (targetError) {
        results.push({ accountId: account.id, status: "failed", error: targetError.message });
        continue;
      }

      try {
        // Per-platform caption override (falls back to the master body).
        const postData = {
          ...postForPlatform({ ...post, body: body.trim() }, account.platform),
          image_url: firstImage,
          media: mediaList,
          link_url: outboundLink,
        };
        const publishResult =
          account.platform === "instagram"
            ? await publishInstagramPost({ account, post: postData })
            : account.platform === "threads"
              ? await publishThreadsPost({ account, post: postData })
              : account.platform === "twitter"
                ? await publishXPost({ account, post: postData })
                : account.platform === "youtube"
                  ? await publishYouTubeVideo({ account, post: postData, options: platformOptions(post, "youtube") } as any)
                  : fbFormat(post) === "reel"
                    ? await publishFacebookReel({ account, post: postData })
                    : fbFormat(post) === "story"
                      ? await publishFacebookStory({ account, post: postData })
                      : await publishFacebookPost({ account, post: postData });

        const sentAt = new Date().toISOString();

        await supabase
          .from("post_targets")
          .update({ status: "sent", external_post_id: publishResult.externalPostId, sent_at: sentAt })
          .eq("post_id", post.id)
          .eq("social_account_id", account.id);

        // Best-effort first comment — never fails the publish itself.
        // (Stories have no comments — skip them.)
        const isStory = account.platform === "facebook" && fbFormat(post) === "story";
        if (!isStory && firstComment?.trim() && publishResult.externalPostId) {
          try {
            if (account.platform === "instagram") {
              await postInstagramComment({ account, mediaId: publishResult.externalPostId, message: firstComment });
            } else if (account.platform === "threads") {
              await postThreadsReply({ account, mediaId: publishResult.externalPostId, message: firstComment });
            } else if (account.platform === "twitter") {
              await postXReply({ account, tweetId: publishResult.externalPostId, message: firstComment });
            } else if (account.platform !== "youtube") {
              await postFacebookComment({ account, postId: publishResult.externalPostId, message: firstComment });
            }
          } catch (commentError) {
            console.warn(`[publish-now] first comment failed for ${account.display_name}:`, commentError.message);
          }
        }

        results.push({ accountId: account.id, name: account.display_name, status: "sent", mode: publishResult.mode });
      } catch (publishError) {
        await supabase
          .from("post_targets")
          .update({ status: "failed", last_error: publishError.message })
          .eq("post_id", post.id)
          .eq("social_account_id", account.id);

        results.push({ accountId: account.id, name: account.display_name, status: "failed", error: publishError.message });
      }
    }

    const allFailed = results.every((r) => r.status === "failed");
    const allSent = results.every((r) => r.status === "sent");
    const finalStatus = allFailed ? "failed" : "sent";

    await supabase
      .from("scheduled_posts")
      .update({ status: finalStatus, sent_at: new Date().toISOString() })
      .eq("id", post.id);

    await logActivity({
      type: allFailed ? "post.failed" : "post.published",
      title: allFailed
        ? "Post failed on all pages"
        : `Published to ${results.filter((r) => r.status === "sent").length} page(s)`,
      status: allFailed ? "error" : allSent ? "success" : "warning",
      meta: { postId: post.id, results: results.map((r) => ({ name: r.name, status: r.status })) },
    });

    return { post, results };
  }
}
