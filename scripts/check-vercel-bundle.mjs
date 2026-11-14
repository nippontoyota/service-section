import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Run after a production build. Test only the files Next traced for deployment,
// so a complete local node_modules cannot hide a missing serverless dependency.
const root = process.cwd();
const bundle = mkdtempSync(join(tmpdir(), "billdesk-bundle-"));
try {
  // Check deployment inputs too: a local build can pass even when Vercel omits a route.
  // Vercel ignore rules follow gitignore semantics; use Git in a disposable directory.
  const filterRoot = join(bundle, "ignore-check");
  mkdirSync(filterRoot);
  assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: filterRoot }).status, 0);
  copyFileSync(join(root, ".vercelignore"), join(filterRoot, ".gitignore"));
  const apiSources = readdirSync(join(root, "app/api"), { recursive: true }).filter(path => path.endsWith("/route.ts")).map(path => "app/api/" + path);
  const required = ["app/page.tsx", "app/b/[code]/route.ts", "app/g/[code]/route.ts", "app/security/page.tsx", "app/security/verify/[code]/page.tsx", ".env.example", ...apiSources];
  const privateFiles = ["bills/customer.json", "bills/customer.pdf", "samples/private/expectations.json", "output/report.csv", ".env.local", "invoice.pdf"];
  const filter = spawnSync("git", ["-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "--stdin"], {
    cwd: filterRoot, input: [...required, ...privateFiles].join("\n") + "\n", encoding: "utf8",
  });
  assert.equal(filter.status, 0, filter.stderr);
  const excluded = new Set(filter.stdout.trim().split("\n"));
  for (const path of required) assert(!excluded.has(path), `Deployment source excluded by .vercelignore: ${path}`);
  for (const path of privateFiles) assert(excluded.has(path), `Private file allowed by .vercelignore: ${path}`);

  for (const route of ["api/uploads/[id]/process", "api/desk", "api/bills/[id]/whatsapp", "api/bills/[id]/attachment", "b/[code]", "g/[code]"]) {
    const trace = resolve(root, ".next/server/app", route, "route.js.nft.json");
    const { files } = JSON.parse(readFileSync(trace, "utf8"));
    if (route.startsWith("api/") && !route.endsWith("/attachment") && !route.endsWith("/whatsapp")) {
      assert(files.some(file => file.endsWith("/pdf.worker.mjs")), `${route}: missing PDF worker`);
      assert(files.some(file => /canvas.*\.node$/.test(file)), `${route}: missing native canvas`);
    }
    for (const file of files) {
      const source = resolve(dirname(trace), file);
      const name = relative(root, source);
      assert(!name.startsWith(".."), `Dependency outside project: ${name}. Use a clean npm ci install.`);
      assert(!/^(?:\.env(?:\.|$)|bills\/|samples\/private\/|output\/)/.test(name)
        && !name.endsWith(".pdf"), `Private file in bundle: ${name}`);
      if (route === "api/desk") continue;
      const target = join(bundle, name);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
    }
  }

  // A synthetic one-page PDF keeps this check independent of customer documents.
  const content = "BT /F1 12 Tf 72 720 Td (BillDesk deployment check) Tj ET\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  writeFileSync(join(bundle, "check.pdf"), pdf);
  const result = spawnSync(process.execPath, ["-e", `
    const { PDFParse } = require("pdf-parse");
    const { readFileSync } = require("node:fs");
    (async () => {
      const parser = new PDFParse({ data: new Uint8Array(readFileSync("check.pdf")) });
      try {
        const text = await parser.getText();
        require("node:assert/strict").match(text.text, /BillDesk deployment check/);
      } finally { await parser.destroy(); }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: bundle, encoding: "utf8", timeout: 30_000, env: { ...process.env, NODE_PATH: "" } });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  console.log("Deployment bundle passed: API sources included, private inputs excluded, isolated PDF extraction and worker/native dependencies.");
} finally {
  rmSync(bundle, { recursive: true, force: true });
}
