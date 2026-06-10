import fs from "node:fs";
import path from "node:path";

// --- Config: which collections to convert and where they go ---------------
const ROOT = process.cwd();

const FAMILIES = {
  "sim-family": {
    sourceDir: "sim_family",
    title: "SIM family",
  },
  "invoice-family": {
    sourceDir: "invoice_family",
    title: "Invoice family",
  },
};

const OUT_ROOT = path.join(ROOT, "api-specs");

// --- Helpers ---------------------------------------------------------------

function slug(str) {
  return String(str)
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .toLowerCase();
}

// Strip /* ... */ block comments and // line comments, then parse JSON.
function tryParseLooseJson(raw) {
  if (!raw || !raw.trim()) return undefined;
  let s = raw;
  // Remove block comments (non-greedy, across newlines)
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  // Remove line comments
  s = s.replace(/^\s*\/\/.*$/gm, "");
  // Remove trailing commas before } or ]
  s = s.replace(/,(\s*[}\]])/g, "$1");
  s = s.trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function jsonSchemaFromExample(example) {
  if (Array.isArray(example)) {
    return {
      type: "array",
      items: example.length ? jsonSchemaFromExample(example[0]) : {},
    };
  }
  if (example === null) return { type: "string", nullable: true };
  const t = typeof example;
  if (t === "object") {
    const properties = {};
    for (const [k, v] of Object.entries(example)) {
      properties[k] = jsonSchemaFromExample(v);
    }
    return { type: "object", properties };
  }
  if (t === "number") return Number.isInteger(example) ? { type: "integer" } : { type: "number" };
  if (t === "boolean") return { type: "boolean" };
  return { type: "string" };
}

function buildServers(hostArr) {
  // hostArr is something like ["{{URL}}"] or ["eseye-idp-{{env}}", "auth", ...]
  const host = (hostArr || []).join(".");
  // Replace {{var}} -> {var} and collect variable names
  const variables = {};
  const varDefaults = { URL: "api.eseye.com", env: "prod", environment: "prod" };
  const url = "https://" + host.replace(/\{\{(\w+)\}\}/g, (_, name) => {
    variables[name] = { default: varDefaults[name] ?? "", description: `Postman variable: ${name}` };
    return `{${name}}`;
  });
  const server = { url };
  if (Object.keys(variables).length) server.variables = variables;
  return server;
}

const DEFAULT_SERVER = {
  url: "https://{URL}",
  variables: {
    URL: { default: "api.eseye.com", description: "Your AnyNet API host (provided by Eseye)." },
  },
};

// Recursively walk Postman items collecting operations.
function collectOperations(items, tag, ops) {
  for (const item of items) {
    if (Array.isArray(item.item)) {
      // Folder. Use the top-level folder as the tag.
      collectOperations(item.item, tag ?? item.name, ops);
    } else if (item.request) {
      ops.push({ item, tag: tag ?? "General" });
    }
  }
}

function convertCollection(collection) {
  const info = collection.info || {};
  const title = info.name || "API";
  const ops = [];
  collectOperations(collection.item || [], undefined, ops);

  const paths = {};
  const tagsSet = new Map();
  const usedOperationIds = new Set();

  for (const { item, tag } of ops) {
    const req = item.request;
    const method = (req.method || "GET").toLowerCase();
    const url = req.url || {};
    const segments = (url.path || []).filter((s) => s !== "" && s !== undefined && s !== null);
    let openapiPath =
      "/" +
      segments
        .map((s) => s.replace(/\{\{(\w+)\}\}/g, (_, name) => `{${name}}`))
        .join("/");
    if (openapiPath === "/") openapiPath = "/";

    // Path params from {var} in the path
    const pathParamNames = [...openapiPath.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
    const parameters = [];
    for (const name of pathParamNames) {
      parameters.push({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
        description: `Postman variable: ${name}`,
      });
    }

    // Query params (include disabled ones as optional documentation)
    for (const q of url.query || []) {
      if (!q.key) continue;
      parameters.push({
        name: q.key,
        in: "query",
        required: false,
        schema: { type: "string" },
      });
    }

    // Request body
    let requestBody;
    if (req.body && req.body.mode === "raw" && req.body.raw) {
      const example = tryParseLooseJson(req.body.raw);
      if (example !== undefined) {
        requestBody = {
          content: {
            "application/json": {
              schema: jsonSchemaFromExample(example),
              example,
            },
          },
        };
      }
    } else if (req.body && req.body.mode === "urlencoded" && Array.isArray(req.body.urlencoded)) {
      const props = {};
      const example = {};
      for (const f of req.body.urlencoded) {
        if (!f.key) continue;
        props[f.key] = { type: "string" };
        example[f.key] = f.value ?? "";
      }
      requestBody = {
        content: {
          "application/x-www-form-urlencoded": {
            schema: { type: "object", properties: props },
            example,
          },
        },
      };
    }

    // operationId
    let opId = slug(`${item.name}`) || `${method}-${slug(openapiPath)}`;
    let candidate = opId;
    let i = 2;
    while (usedOperationIds.has(candidate)) candidate = `${opId}-${i++}`;
    usedOperationIds.add(candidate);

    const operation = {
      summary: item.name,
      operationId: candidate,
      tags: [tag],
    };

    const description =
      typeof req.description === "string" ? req.description : req.description?.content;
    if (description) operation.description = description;
    if (parameters.length) operation.parameters = parameters;
    if (requestBody) operation.requestBody = requestBody;

    operation.responses = {
      "200": { description: "Successful response" },
    };

    // Per-operation server override if host differs from {{URL}}
    const hostStr = (url.host || []).join(".");
    if (hostStr && hostStr !== "{{URL}}") {
      operation.servers = [buildServers(url.host)];
      // This op authenticates differently (e.g. token endpoint) -> no bearer
      operation.security = [];
    }

    tagsSet.set(tag, true);

    if (!paths[openapiPath]) paths[openapiPath] = {};
    if (paths[openapiPath][method]) {
      // Collision: make path unique-ish is not valid; keep first, skip dup.
      console.warn(`  ! Skipping duplicate ${method.toUpperCase()} ${openapiPath} (${item.name})`);
      continue;
    }
    paths[openapiPath][method] = operation;
  }

  const doc = {
    openapi: "3.1.0",
    info: {
      title,
      version: "2.0.0",
      description:
        (typeof info.description === "string" ? info.description : info.description?.content) ||
        `${title} reference, generated from the Eseye Postman collection.`,
    },
    servers: [DEFAULT_SERVER],
    security: [{ bearerAuth: [] }],
    tags: [...tagsSet.keys()].map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "OAuth 2.0 client-credentials access token. See the developer guide for how to obtain one.",
        },
      },
    },
  };

  return doc;
}

// --- Main ------------------------------------------------------------------

function findCollections(absDir) {
  const result = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      result.push(...findCollections(full));
    } else if (entry.name.endsWith(".postman_collection.json")) {
      result.push(full);
    }
  }
  return result;
}

let total = 0;
const manifest = {};

for (const [familyKey, family] of Object.entries(FAMILIES)) {
  const srcAbs = path.join(ROOT, family.sourceDir);
  if (!fs.existsSync(srcAbs)) {
    console.warn(`Source dir not found: ${family.sourceDir}`);
    continue;
  }
  const outDir = path.join(OUT_ROOT, familyKey);
  fs.mkdirSync(outDir, { recursive: true });
  manifest[familyKey] = [];

  for (const file of findCollections(srcAbs)) {
    const collection = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(`Converting: ${path.relative(ROOT, file)}`);
    const doc = convertCollection(collection);
    const name = slug(collection.info?.name || path.basename(file).replace(".postman_collection.json", ""));
    const outFile = path.join(outDir, `${name}.json`);
    fs.writeFileSync(outFile, JSON.stringify(doc, null, 2) + "\n");
    const opCount = Object.values(doc.paths).reduce((n, m) => n + Object.keys(m).length, 0);
    console.log(`  -> ${path.relative(ROOT, outFile)} (${opCount} operations)`);
    manifest[familyKey].push({
      title: collection.info?.name || name,
      spec: `/api-specs/${familyKey}/${name}.json`,
      key: name,
      operations: opCount,
    });
    total++;
  }
}

fs.writeFileSync(path.join(OUT_ROOT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`\nDone. Converted ${total} collections. Manifest at api-specs/manifest.json`);
