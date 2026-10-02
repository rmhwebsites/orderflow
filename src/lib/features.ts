// The workspace settings page ships in the platform phase. Until it exists,
// links to it stay hidden so nothing leads to a not-found page: the top bar
// Settings button, the sync banner's store connection link and the empty
// desk's Open Settings button all check this flag. SETTINGS STAGE: flip it
// to true (or remove the flag) when /w/[slug]/settings lands, and decide per
// link which roles see it (the store connection is platform-admin only).
export const SETTINGS_PAGE_AVAILABLE = false;
