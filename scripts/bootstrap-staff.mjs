import { createClient } from "@supabase/supabase-js";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Set Supabase URL and service-role key in .env.local first.");
const service = createClient(url,key,{ auth: { persistSession:false,autoRefreshToken:false } });
// Precomputed, individually salted hashes of the three owner-requested initial passwords.
// The server never sends plaintext passwords to the database or uses these as a login bypass.
for (const [staffId, fullName, role, passwordHash] of [
  ["admin01","Centre Administrator","super_admin","scrypt$32768$8$3$3f7d671a544db0af2a92bb9b30c05a85$3f7815f9c422dfe6710886bb391ea262fc5e9c2cc581b5d49262bdbafc85f2e1d8aa765b5009438615553b22eb3758a2cbc94fb77b65cb375a1c1e76249636b9"],
  ["cashier01","Cashier","cashier","scrypt$32768$8$3$41c2f0189f919f8390a01378a532d223$a218262a7294a2b9ba6d71e4ecabe0a6691f724ac31444f102dd1e25f02d1807b02c0e034f32521b22b5fb0f055e110c520847626496ef854dd33109f6c3c62f"],
  ["advisor01","Service Advisor","service_advisor","scrypt$32768$8$3$aa080b57549b6ef1ae5bf11b617af073$b612633463b1f5ba31fd1b86056a6a7cb8ad6ccbb1b7ce715e9d6a49a8a127893a1e54af6a37d703b29c518d992109775cb68916306ce441e3bb942cb51c21f1"],
]) {
  const { data, error } = await service.rpc("app_bootstrap_staff", { login_id:staffId,name:fullName,role_name:role,new_hash:passwordHash });
  if (error) throw new Error("Apply 202611040003_app_auth.sql first. Bootstrap failed: " + error.message);
  console.log(staffId + (data ? ": initial password hash installed." : ": already configured; password unchanged."));
}
console.log("Initial accounts are ready. Admin-created accounts still use temporary passwords and must change them at first login.");
