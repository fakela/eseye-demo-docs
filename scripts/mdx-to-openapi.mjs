import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

// Legacy families that are one-endpoint-per-page (title = "METHOD /path").
const FAMILIES = {
  location: { dir: "api/location", title: "Location API", server: "https://location.eseye.com" },
  margay: { dir: "api/margay", title: "Margay API", server: "https://margay.eseye.com" },
  tigrillo: { dir: "api/tigrillo", title: "Tigrillo API", server: "https://siam.eseye.com" },
  tigrina: { dir: "api/tigrina", title: "Tigrina API", server: "https://tigrina.eseye.com" },
};

const OUT_DIR = path.join(ROOT, "api-specs", "legacy");

function decodeEntitiesAndTags(html) {
  let s = html;
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n");
  s = s.replace(/<[^>]+>/g, ""); // strip remaining tags
  const entities = {
    "&#123;": "{",
    "&#125;": "}",
    "&#95;": "_",
    "&#42;": "*",
    "&#39;": "'",
    "&quot;": '"',
    "&nbsp;": " ",
    "&lt;": "<",
    "&gt;": ">",
    "&amp;": "&",
  };
  for (const [k, v] of Object.entries(entities)) s = s.split(k).join(v);
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  // Smart quotes -> straight quotes
  s = s.replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"').replace(/[\u2018\u2019\u201A\u201B]/g, "'");
  return s;
}

function looseParseJson(text) {
  if (!text) return undefined;
  let s = decodeEntitiesAndTags(text);
  s = s.replace(/\/\*[\s\S]*?\*\//g, ""); // block comments
  s = s.replace(/^\s*\/\/.*$/gm, ""); // line comments
  s = s.replace(/,(\s*[}\]])/g, "$1"); // trailing commas
  s = s.trim();
  if (!s) return undefined;
  // If it does not start with { [ or ", bail.
  if (!/^[{[\"]/.test(s)) {
    // maybe a bare word like pong
    return undefined;
  }
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// Find a region of the file between a start heading and the next h2.
function sliceSection(body, startRegex) {
  const startMatch = body.match(startRegex);
  if (!startMatch) return undefined;
  const startIdx = startMatch.index + startMatch[0].length;
  const rest = body.slice(startIdx);
  // Stop at the next <h2 ...> heading
  const nextH2 = rest.search(/<h2[\s>]/i);
  return nextH2 === -1 ? rest : rest.slice(0, nextH2);
}

// Extract a JSON example from a region: prefer <pre><code>, else <p>-line block
// following an "Example" h3/h4.
function extractExample(region) {
  if (!region) return undefined;
  // 1. <pre><code>...</code></pre>
  const pre = region.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/i);
  if (pre) {
    const parsed = looseParseJson(pre[1]);
    if (parsed !== undefined) return parsed;
  }
  // 2. After an Example heading, gather <p> lines.
  const exHeading = region.match(/<h[34][^>]*>[^<]*example[^<]*<\/h[34]>/i);
  let tail = exHeading ? region.slice(exHeading.index + exHeading[0].length) : region;
  const pLines = [...tail.matchAll(/<p>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
  if (pLines.length) {
    const joined = pLines.join("\n");
    const parsed = looseParseJson(joined);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function extractRequiredKeys(region) {
  const required = new Set();
  if (!region) return required;
  // Find a table whose header mentions "Required"
  const tables = [...region.matchAll(/<table>[\s\S]*?<\/table>/gi)].map((m) => m[0]);
  for (const table of tables) {
    if (!/Required/i.test(table)) continue;
    const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
    for (const row of rows) {
      const cells = [...row.matchAll(/<td>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
      if (cells.length < 2) continue;
      const key = decodeEntitiesAndTags(cells[0]).trim();
      const lastCell = cells[cells.length - 1];
      if (/checkmark|✓/i.test(lastCell)) {
        if (key && /^[A-Za-z0-9_]+$/.test(key)) required.add(key);
      }
    }
  }
  return required;
}

function jsonSchemaFromExample(example) {
  if (Array.isArray(example)) {
    return { type: "array", items: example.length ? jsonSchemaFromExample(example[0]) : {} };
  }
  if (example === null) return {};
  const t = typeof example;
  if (t === "object") {
    const properties = {};
    for (const [k, v] of Object.entries(example)) properties[k] = jsonSchemaFromExample(v);
    return { type: "object", properties };
  }
  if (t === "number") return Number.isInteger(example) ? { type: "integer" } : { type: "number" };
  if (t === "boolean") return { type: "boolean" };
  return { type: "string" };
}

function readFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return { fm: {}, fmRaw: "", body: content, end: 0 };
  const fmRaw = m[1];
  const fm = {};
  for (const line of fmRaw.split("\n")) {
    const mm = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (mm) fm[mm[1]] = mm[2].replace(/^"(.*)"$/, "$1");
  }
  return { fm, fmRaw, body: content.slice(m[0].length), end: m[0].length };
}

const TITLE_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)$/;

let totalSpecs = 0;
let totalOps = 0;
let totalPatched = 0;
fs.mkdirSync(OUT_DIR, { recursive: true });

for (const [key, fam] of Object.entries(FAMILIES)) {
  const dirAbs = path.join(ROOT, fam.dir);
  const files = fs
    .readdirSync(dirAbs)
    .filter((f) => f.endsWith(".mdx"))
    .map((f) => path.join(dirAbs, f));

  const paths = {};
  const specRel = `/api-specs/legacy/${key}.json`;
  let opCount = 0;

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    const { fm, body } = readFrontmatter(content);
    const title = fm.title || "";
    const tm = title.match(TITLE_RE);
    if (!tm) continue; // not an endpoint page
    const method = tm[1].toLowerCase();
    const urlPath = tm[2];

    const reqRegion = sliceSection(body, /<h2[^>]*>\s*Request\s*(Body|key)[^<]*<\/h2>/i);
    const resRegion = sliceSection(body, /<h2[^>]*>\s*Response[s]?[^<]*<\/h2>/i);

    const reqExample = extractExample(reqRegion);
    const resExample = extractExample(resRegion);
    const requiredKeys = extractRequiredKeys(reqRegion);

    const operation = {
      summary: urlPath.split("/").pop(),
      operationId: `${method}-${urlPath.replace(/[^A-Za-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`.toLowerCase(),
      tags: [fam.title],
    };
    if (fm.description) operation.description = fm.description;

    if (reqExample !== undefined) {
      const schema = jsonSchemaFromExample(reqExample);
      if (schema.type === "object" && requiredKeys.size) {
        const req = Object.keys(schema.properties || {}).filter((k) => requiredKeys.has(k));
        if (req.length) schema.required = req;
      }
      operation.requestBody = {
        content: { "application/json": { schema, example: reqExample } },
      };
    }

    const response = { description: "Successful response" };
    if (resExample !== undefined) {
      response.content = {
        "application/json": { schema: jsonSchemaFromExample(resExample), example: resExample },
      };
    }
    operation.responses = { "200": response };

    if (!paths[urlPath]) paths[urlPath] = {};
    paths[urlPath][method] = operation;
    opCount++;

    // Patch the page frontmatter to add the openapi reference.
    const openapiValue = `${specRel} ${tm[1]} ${urlPath}`;
    let newContent;
    if (/^openapi:/m.test(content.slice(0, content.indexOf("\n---") + 4))) {
      newContent = content.replace(/^openapi:.*$/m, `openapi: "${openapiValue}"`);
    } else {
      // Insert after the description line (or after title) within frontmatter.
      newContent = content.replace(
        /^(---\n[\s\S]*?\ndescription:.*\n)/,
        `$1openapi: "${openapiValue}"\n`
      );
      if (newContent === content) {
        // No description; insert after title line.
        newContent = content.replace(/^(---\ntitle:.*\n)/, `$1openapi: "${openapiValue}"\n`);
      }
    }
    if (newContent !== content) {
      fs.writeFileSync(file, newContent);
      totalPatched++;
    }
  }

  const doc = {
    openapi: "3.1.0",
    info: {
      title: fam.title,
      version: "1.0.0",
      description: `${fam.title} reference, generated from the Eseye documentation.`,
    },
    servers: [{ url: fam.server }],
    tags: [{ name: fam.title }],
    paths,
  };
  fs.writeFileSync(path.join(OUT_DIR, `${key}.json`), JSON.stringify(doc, null, 2) + "\n");
  console.log(`${key}: ${opCount} operations -> ${specRel}`);
  totalSpecs++;
  totalOps += opCount;
}

console.log(`\nDone. ${totalSpecs} specs, ${totalOps} operations, ${totalPatched} pages patched.`);
