import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

const FAMILIES = {
  "package-api": {
    dir: "api/package",
    title: "Package API",
    server: "https://package.api.anynetiot.com",
  },
  portfolio: {
    dir: "api/portfolio",
    title: "Portfolio API",
    server: "https://portfolio.api.anynetiot.com",
  },
};

const OUT_DIR = path.join(ROOT, "api-specs", "legacy");

function decode(html) {
  let s = html;
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  const entities = {
    "&#123;": "{", "&#125;": "}", "&#95;": "_", "&#42;": "*", "&#39;": "'",
    "&quot;": '"', "&nbsp;": " ", "&lt;": "<", "&gt;": ">", "&amp;": "&",
  };
  for (const [k, v] of Object.entries(entities)) s = s.split(k).join(v);
  s = s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
  s = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  return s;
}

function looseParse(text) {
  if (!text) return undefined;
  let s = decode(text);
  s = s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  s = s.replace(/,(\s*[}\]])/g, "$1").trim();
  if (!/^[{[]/.test(s)) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function schemaFromExample(ex) {
  if (Array.isArray(ex)) return { type: "array", items: ex.length ? schemaFromExample(ex[0]) : {} };
  if (ex === null) return {};
  const t = typeof ex;
  if (t === "object") {
    const properties = {};
    for (const [k, v] of Object.entries(ex)) properties[k] = schemaFromExample(v);
    return { type: "object", properties };
  }
  if (t === "number") return Number.isInteger(ex) ? { type: "integer" } : { type: "number" };
  if (t === "boolean") return { type: "boolean" };
  return { type: "string" };
}

function frontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---/);
  return m ? content.slice(m[0].length) : content;
}

function tagFromFile(file) {
  const base = path.basename(file, ".mdx").replace(/-operations$/, "");
  const words = base.split("-");
  return words.map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

function extractBodyParams(part) {
  const labelMatch = part.match(/<span>\s*Body(?:\s*parameters)?\s*:\s*<\/span>/i);
  if (!labelMatch) return undefined;
  let seg = part.slice(labelMatch.index + labelMatch[0].length);
  const cutPoints = ["<strong>", "</li>", "<h", "The API"]
    .map((t) => seg.indexOf(t))
    .filter((i) => i >= 0);
  if (cutPoints.length) seg = seg.slice(0, Math.min(...cutPoints));
  const tokens = [...seg.matchAll(/<span>([A-Za-z0-9_]+)<\/span>(\s*<b>[\s\S]*?<\/b>)?/g)];
  if (!tokens.length) return undefined;
  const properties = {};
  const required = [];
  for (const t of tokens) {
    const name = t[1];
    properties[name] = { type: "string" };
    if (t[2]) required.push(name);
  }
  const schema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

function extractResponseExample(part) {
  const idx = part.search(/Response schema/i);
  const tail = idx >= 0 ? part.slice(idx) : part;
  const pre = tail.match(/<pre><code>([\s\S]*?)<\/code><\/pre>/i);
  if (pre) {
    const parsed = looseParse(pre[1]);
    if (parsed !== undefined) return parsed;
  }
  const exHeading = tail.match(/<h[34][^>]*>[^<]*example[^<]*<\/h[34]>/i);
  const region = exHeading ? tail.slice(exHeading.index + exHeading[0].length) : tail;
  const pLines = [...region.matchAll(/<p>([\s\S]*?)<\/p>/gi)].map((m) => m[1]);
  if (pLines.length) {
    const parsed = looseParse(pLines.join("\n"));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

const CALL_RE = /Call\s*<span>\s*(GET|POST|PUT|PATCH|DELETE)\s+([\s\S]*?)<\/span>/i;

fs.mkdirSync(OUT_DIR, { recursive: true });

for (const [key, fam] of Object.entries(FAMILIES)) {
  const dirAbs = path.join(ROOT, fam.dir);
  const files = fs.readdirSync(dirAbs).filter((f) => f.endsWith(".mdx")).map((f) => path.join(dirAbs, f));
  const paths = {};
  const tags = new Map();
  const usedIds = new Set();
  let opCount = 0;

  for (const file of files) {
    const body = frontmatter(fs.readFileSync(file, "utf8"));
    const tag = tagFromFile(file);
    const segments = body.split(/(?=<h2[\s>])/i);
    for (const part of segments) {
      const hm = part.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
      const cm = part.match(CALL_RE);
      if (!hm || !cm) continue;
      const heading = decode(hm[1]).trim();
      const method = cm[1].toLowerCase();
      let p = decode(cm[2]).trim().split("?")[0].trim();
      if (!p.startsWith("/")) p = "/" + p;
      p = p.replace(/\/$/, "") || "/";

      const pathParams = [...p.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      const parameters = pathParams.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));

      const op = {
        summary: heading,
        operationId: "",
        tags: [tag],
      };
      const firstP = part.match(/<p>([\s\S]*?)<\/p>/i);
      if (firstP) {
        const d = decode(firstP[1]).trim();
        if (d) op.description = d;
      }
      if (parameters.length) op.parameters = parameters;

      if (["post", "put", "patch"].includes(method)) {
        const schema = extractBodyParams(part);
        if (schema) {
          op.requestBody = { content: { "application/json": { schema } } };
        }
      }

      const resEx = extractResponseExample(part);
      const response = { description: "Successful response" };
      if (resEx !== undefined) {
        response.content = { "application/json": { schema: schemaFromExample(resEx), example: resEx } };
      }
      op.responses = { "200": response };

      let id = `${method}-${p.replace(/[^A-Za-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}`.toLowerCase();
      let cand = id, i = 2;
      while (usedIds.has(cand)) cand = `${id}-${i++}`;
      usedIds.add(cand);
      op.operationId = cand;

      if (!paths[p]) paths[p] = {};
      if (paths[p][method]) {
        continue; // skip duplicate method+path
      }
      paths[p][method] = op;
      tags.set(tag, true);
      opCount++;
    }
  }

  const doc = {
    openapi: "3.1.0",
    info: {
      title: fam.title,
      version: "2.0.0",
      description: `${fam.title} reference, generated from the Eseye documentation.`,
    },
    servers: [{ url: fam.server }],
    security: [{ bearerAuth: [] }],
    tags: [...tags.keys()].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      },
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, `${key}.json`), JSON.stringify(doc, null, 2) + "\n");
  console.log(`${key}: ${opCount} operations across ${tags.size} resources -> /api-specs/legacy/${key}.json`);
}
