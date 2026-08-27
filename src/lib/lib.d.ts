// The lib/*.js files are ported verbatim from the original Next.js app and are
// intentionally untyped. Declaring them as `any` keeps TypeScript from inferring
// (and over-constraining) their signatures from individual call sites, so the
// same helper can be called with different argument shapes — exactly as the
// original JavaScript allowed.
declare module "*/lib/facebook";
declare module "*/lib/instagram";
declare module "*/lib/youtube";
declare module "*/lib/canva";
declare module "*/lib/activity";
declare module "*/lib/utm";
declare module "*/lib/compliance";
declare module "*/lib/sports";
declare module "*/lib/sportsEntities";
declare module "*/lib/facebookOAuth";
declare module "*/lib/instagramOAuth";
declare module "*/lib/postContent";
declare module "*/lib/postFields";
declare module "*/lib/postiz";
declare module "*/lib/metaError";
declare module "*/lib/accountHealth";
declare module "*/lib/metaSignedRequest";
