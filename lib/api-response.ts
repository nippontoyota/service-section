export async function readApiResponse(response: Response) {
  const fallback = response.status === 404
    ? "This action is unavailable on the server (HTTP 404). Refresh BillDesk and try again. If it persists, contact your administrator."
    : response.ok
      ? "BillDesk returned an unexpected response. Refresh the page and try again."
      : `BillDesk could not complete the request (HTTP ${response.status}). Please retry.`;
  let result;
  try { result = await response.json(); }
  catch { throw new Error(fallback); }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(fallback);
  if (!response.ok) throw new Error(typeof result.error === "string" && result.error ? result.error : fallback);
  return result;
}
