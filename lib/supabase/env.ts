// Public values only. The service-role key is read solely by scripts/seed.ts.
// Each variable is referenced literally so Next.js can inline it into the
// browser bundle. The key may use Supabase's newer "publishable" name or the
// legacy "anon" name.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
export const SUPABASE_ANON_KEY = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)!;
