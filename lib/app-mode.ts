export const configured = () => Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
export const demoEnabled = () => process.env.NODE_ENV !== "production" && process.env.SERVICE_DESK_DEMO === "true"
  && !process.env.NEXT_PUBLIC_SUPABASE_URL && !process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY;
