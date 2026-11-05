// Retired: bill records, PDFs and financial history are retained permanently.
Deno.serve(() => new Response(JSON.stringify({ retired: true, deleted: 0 }), {
  status: 410, headers: { "Content-Type": "application/json" },
}));
