// Our own minimum for new passwords (sign-up, reset, change; security review SEC-06). The
// Supabase project's Auth setting should match (Authentication → Policies → minimum length 12,
// leaked-password protection on); this check gives a clear message before the server does.
export const MIN_PASSWORD = 12;

export const passwordTooShort = (p: string) => p.length < MIN_PASSWORD;
