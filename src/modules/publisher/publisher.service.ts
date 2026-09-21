import { Injectable } from "@nestjs/common";
import { publishFacebookPost, publishFacebookReel, publishFacebookStory, postFacebookComment } from "../../lib/facebook";
import { publishInstagramPost, postInstagramComment } from "../../lib/instagram";
import { publishPostizPost } from "../../lib/postiz";
import { publishYouTubeVideo } from "../../lib/youtube";
import { logActivity } from "../../lib/activity";
import { assertPublishable, postForPlatform, platformOptions, fbFormat } from "../../lib/postContent";
import { noteAccountPublishFailure, clearAccountPublishFailure } from "../../lib/accountHealth";

// The QUEUE publisher, shared by /api/cron/publish and /api/posts/retry.
//
// It exists because the platform dispatch below was duplicated across every
// publish path, and a channel added to one copy was silently missing from the
// others — which is exactly how a retry that handled Facebook but not Postiz
// would have shipped. One copy means a new platform is wired in once and every
// caller gets it. Compare the note in lib/postContent.js (assertPublishable)
// about the FINAL branch being Facebook: a miss here doesn't error, it posts to
// the wrong place with the wrong token, so the branch order is load-bearing.
//
// Scope: targets already sitting at "scheduled" with no external_post_id, i.e.
// work OUR queue owns. The composer's immediate-publish paths (posts.create,
// approvals, publish-now) keep their own inline dispatch because they also
// decide scheduling semantics — YouTube's native publishAt, per-target review
// stamps — that don't apply once a target is queued.
@Injectable()
export class PublisherService {
  // Publish a set of queued targets belonging to ONE post. Each target is
  // independent: one failing never stops the rest, and every outcome is written
  // to the target row before moving on, so an interrupted run leaves a truthful
  // record rather than a silent gap.
  //
  // `context` only labels logs ("cron" / "retry") — it changes no behaviour.
  async publishTargets(
    supabase: any,
    post: any,
    targets: any[],
    { context = "cron" }: { context?: string } = {},
  ): Promise<{ published: number; failed: number }> {
    let published = 0;
    let failed = 0;

    for (const target of targets) {
      const account: any = target.social_accounts;
      try {
        assertPublishable(account);
        // Per-platform caption override (falls back to the master body).
        const postData = postForPlatform(post, account.platform);
        // Then the per-TARGET override, if this page carries one — an edit made
        // when re-sending a failed delivery. Applied last so it wins over the
        // platform caption, which is the point: it was written for this page.
        // linkUrl is checked by presence, not truthiness, so clearing the link
        // in that edit actually clears it instead of falling back to the post's.
        const override = target.content_override;
        if (override?.body) postData.body = override.body;
        if (override && "linkUrl" in override) postData.link_url = override.linkUrl || null;
        const result =
          // Threads / standalone Instagram / X relay through Postiz. Tested
          // first: the account keeps its real platform value, so it would
          // otherwise fall into a native branch. Postiz has no add-comment
          // endpoint, so the first comment travels with the post.
          account.publish_via === "postiz"
            ? await publishPostizPost({
                account,
                post: postData,
                options: platformOptions(post, account.platform),
                firstComment: post.first_comment || "",
              })
            : account.platform === "instagram"
              ? await publishInstagramPost({ account, post: postData })
              : account.platform === "youtube"
                ? await publishYouTubeVideo({ account, post: postData, options: platformOptions(post, "youtube") } as any)
                : fbFormat(post) === "reel"
                  ? await publishFacebookReel({ account, post: postData })
                  : fbFormat(post) === "story"
                    ? await publishFacebookStory({ account, post: postData })
                    : await publishFacebookPost({ account, post: postData });

        await supabase
          .from("post_targets")
          .update({
            status: "sent",
            external_post_id: result.externalPostId,
            sent_at: new Date().toISOString(),
            last_error: null,
            // Cleared with the error: it describes the PREVIOUS id, and leaving
            // it behind would let a later, unrelated failure on this target look
            // like a confirmed rejection and slip past the double-post guard.
            publish_rejected_at: null,
          })
          .eq("id", target.id);
        published++;
        // A publish proves the token still works — lift any earlier flag.
        await clearAccountPublishFailure(account);

        // Stories have no comments — skip the first comment for them. Postiz
        // already submitted it with the post, so skip those too.
        const isStory = account.platform === "facebook" && fbFormat(post) === "story";
        if (!isStory && !result.firstCommentIncluded && post.first_comment?.trim() && result.externalPostId) {
          try {
            if (account.platform === "instagram") {
              await postInstagramComment({ account, mediaId: result.externalPostId, message: post.first_comment });
            } else if (account.platform === "facebook") {
              await postFacebookComment({ account, postId: result.externalPostId, message: post.first_comment });
            }
          } catch (e) {
            console.warn(`[${context}] first comment failed for ${account.display_name}:`, e.message);
          }
        }
      } catch (err) {
        await supabase.from("post_targets").update({ status: "failed", last_error: err.message }).eq("id", target.id);
        failed++;
        // Token/permission/restriction failures are about the page, not this
        // post — mark it so the UI says "reconnect" instead of failing every
        // future post to it with the same opaque message.
        await noteAccountPublishFailure(account, err.message);
        await logActivity({
          type: "post.failed",
          title:
            context === "retry"
              ? `Retry failed on ${account.display_name}`
              : `Queued post failed on ${account.display_name}`,
          status: "error",
          meta: { postId: post.id, error: err.message },
        });
      }
    }

    return { published, failed };
  }

  // Recompute a post's status from its targets. Shared by the publish loop, the
  // retry path and the stranded-target sweep so the three can't drift — they
  // answer the same question ("what is this post now?") and a second copy of
  // this ternary would be exactly the kind of drift that hides a status bug.
  async refreshPostStatus(supabase: any, postId: string) {
    const { data: fresh } = await supabase.from("post_targets").select("status").eq("post_id", postId);
    const statuses = (fresh || []).map((t: any) => t.status);
    const newStatus = statuses.includes("pending_review")
      ? "pending_review"
      : statuses.some((st: string) => st === "sent" || st === "scheduled")
        ? statuses.includes("scheduled")
          ? "scheduled"
          : "sent"
        : "failed";
    await supabase
      .from("scheduled_posts")
      .update({ status: newStatus, sent_at: newStatus === "sent" ? new Date().toISOString() : null })
      .eq("id", postId);
    return newStatus;
  }
}
