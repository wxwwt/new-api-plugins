// Replicate image predictions. The host owns HTTP, polling, and billing.
const FLUX_MODEL = "black-forest-labs/flux-1.1-pro";
const GPT_MODEL = "openai/gpt-image-2";
const MODELS = [FLUX_MODEL, GPT_MODEL];
const MAX_IMAGE_COUNT = 128;
const MAX_INLINE_IMAGE_BYTES = 1048576;

export const meta = {
  apiVersion: 1,
  key: "replicate",
  name: "Replicate",
  version: "1.0.0",
  icon: "text:R",
  author: { name: "wxwwt", url: "https://github.com/wxwwt" },
  description: {
    en: "Replicate image generation and editing with native model inputs",
    zh: "通过 Replicate 原生模型参数生成和编辑图片",
  },
  baseUrl: "https://api.replicate.com",
  auth: "api_key",
  channelTypes: [56],
  models: MODELS,
  fetchMode: "per_task",
  upstreams: ["vendor", "new_api"],
  usageSchema: {
    image_count: {
      type: "number",
      unit: "count",
      unitLabel: { en: "image", zh: "张" },
      description: { en: "Image generation unit price", zh: "图片生成单价" },
    },
  },
  usageExamples: [{ label: "1 image", facts: { image_count: 1 } }],
  routes: [
    { method: "POST", path: "/replicate/v1/predictions", type: "submit", decode: "createPrediction", render: "prediction" },
    { method: "GET", path: "/replicate/v1/predictions/:task_id", type: "query", render: "prediction" },
  ],
  protocols: ["openai_image"],
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function count(value, field, maxCount) {
  if (!Number.isInteger(value) || value < 1 || value > maxCount)
    throw new Error(field + " must be an integer between 1 and " + maxCount);
  return value;
}

function countFromInput(req, input, nativeInput, model) {
  const maxCount = model === FLUX_MODEL ? 1 : 10;
  const declared = [];
  if (req.n !== undefined && req.n !== null) declared.push(["n", count(req.n, "n", maxCount)]);
  for (const key of ["number_of_images", "num_outputs"]) {
    if (input[key] === undefined || input[key] === null) continue;
    if (model === FLUX_MODEL) throw new Error("Flux 1.1 Pro does not support " + key);
    if (model === GPT_MODEL && key === "num_outputs") throw new Error("GPT Image 2 does not support num_outputs");
    declared.push(["input." + key, count(input[key], "input." + key, maxCount)]);
  }
  if (declared.length) {
    const expected = declared[0][1];
    for (const [field, value] of declared) {
      if (value !== expected) throw new Error(field + " must match " + declared[0][0]);
    }
    if (nativeInput && expected > 1 && input.number_of_images === undefined && input.num_outputs === undefined)
      throw new Error("n greater than 1 requires input.number_of_images or input.num_outputs");
    return expected;
  }
  return 1;
}

function fluxSize(input, size) {
  if (typeof size !== "string") return;
  const normalizedSize = size.trim();
  const match = /^(\d+)x(\d+)$/.exec(normalizedSize);
  if (!match) return;
  const width = Number(match[1]), height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return;
  const known = {
    "1792x1024": "16:9", "1024x1792": "9:16", "1536x1024": "3:2", "1024x1536": "2:3",
  };
  if (known[normalizedSize]) input.aspect_ratio = known[normalizedSize];
  else if (width === height) input.aspect_ratio = "1:1";
  else {
    let a = width, b = height;
    while (b) { const remainder = a % b; a = b; b = remainder; }
    const ratio = width / a + ":" + height / a;
    if (["16:9", "9:16", "3:2", "2:3", "4:5", "5:4", "3:4", "4:3"].includes(ratio))
      input.aspect_ratio = ratio;
    else {
      input.aspect_ratio = "custom";
      input.width = Math.max(256, Math.min(1440, Math.round(width / 32) * 32));
      input.height = Math.max(256, Math.min(1440, Math.round(height / 32) * 32));
    }
  }
}

function imageUploads(files) {
  const images = [];
  for (const file of files || []) {
    if (!/^image(?:\[\d*\])?$/.test(file.field)) continue;
    if (file.size > MAX_INLINE_IMAGE_BYTES)
      throw new Error("uploaded image exceeds 1 MiB; provide a hosted image URL in input instead");
    images.push({ __fileRef: file.ref, encoding: "dataUrl", maxBytes: MAX_INLINE_IMAGE_BYTES });
  }
  return images;
}

function formRequest(ctx) {
  const req = {};
  for (const [key, values] of Object.entries(ctx.body.fields || {})) {
    if (!Array.isArray(values) || values.length !== 1) throw new Error(key + " must be supplied once");
    req[key] = values[0];
  }
  for (const key of ["input", "extra_fields"]) {
    if (req[key] === undefined) continue;
    try { req[key] = JSON.parse(req[key]); }
    catch (_) { throw new Error(key + " must be a JSON object"); }
  }
  if (req.n !== undefined) {
    if (!/^\d+$/.test(req.n)) throw new Error("n must be a positive integer");
    req.n = Number(req.n);
  }
  return req;
}

function normalizeRequest(ctx) {
  let req;
  if (ctx.body && ctx.body.kind === "json") req = ctx.body.value;
  else if (ctx.body && ctx.body.kind === "multipart") req = formRequest(ctx);
  else throw new Error("JSON or multipart body required");
  if (!isObject(req)) throw new Error("request body must be an object");
  const model = text(ctx.model || req.model);
  if (!model) throw new Error("model is required");
  const upstreamModel = text(ctx.upstreamModel) || model;
  // Before distribution the host may decode an alias without knowing the
  // selected channel's upstream model. The request builder checks the target.
  if (req.model !== undefined && req.model !== model) throw new Error("model does not match the selected model");
  if (req.stream !== undefined && req.stream !== false && req.stream !== "false")
    throw new Error("stream is not supported for Replicate image requests");
  if (req.response_format !== undefined && req.response_format !== "url" && req.response_format !== "b64_json")
    throw new Error("response_format must be url or b64_json");
  const nativeInput = req.input !== undefined;
  if (nativeInput && !isObject(req.input)) throw new Error("input must be a JSON object");
  const input = nativeInput ? { ...req.input } : {};
  if (input.prompt === undefined && text(req.prompt)) input.prompt = text(req.prompt);
  if (!text(input.prompt)) throw new Error("prompt is required");

  if (!nativeInput) {
    if (upstreamModel === FLUX_MODEL) {
      fluxSize(input, req.size);
      if (text(req.output_format)) input.output_format = text(req.output_format);
      if (req.quality === "hd" || req.quality === "high") input.prompt_upsampling = true;
    }
    if (req.extra_fields !== undefined && !isObject(req.extra_fields)) throw new Error("extra_fields must be a JSON object");
    for (const [key, value] of Object.entries(req.extra_fields || {})) input[key] = value;
    const excluded = new Set(["model", "prompt", "n", "size", "quality", "response_format", "stream", "input", "extra_fields", "image", "images"]);
    for (const [key, value] of Object.entries(req)) {
      if (!excluded.has(key)) input[key] = value;
    }
  }

  const uploads = ctx.body.kind === "multipart" ? imageUploads(ctx.body.files) : [];
  if (uploads.length) {
    if (upstreamModel === FLUX_MODEL) {
      if (input.image_prompt !== undefined) throw new Error("image_prompt conflicts with uploaded image");
      if (uploads.length !== 1) throw new Error("Flux image edit accepts one uploaded image");
      input.image_prompt = uploads[0];
    } else {
      if (input.input_images !== undefined) throw new Error("input_images conflicts with uploaded images");
      input.input_images = uploads;
    }
  }
  if (ctx.operation === "edit" && !uploads.length && input.image_prompt === undefined && input.input_images === undefined)
    throw new Error("image is required for edits");

  const imageCount = countFromInput(req, input, nativeInput, upstreamModel);
  if (!nativeInput && req.n !== undefined && input.number_of_images === undefined && input.num_outputs === undefined) {
    if (upstreamModel !== FLUX_MODEL) input.number_of_images = imageCount;
  }
  return { kind: "submit", model, action: ctx.operation === "edit" ? "image_edit" : "image_generate", requestBody: { input, image_count: imageCount } };
}

function status(body) {
  const value = text(body && body.status).toLowerCase();
  if (value === "starting") return "QUEUED";
  if (value === "processing") return "IN_PROGRESS";
  if (value === "succeeded") return "SUCCESS";
  if (value === "failed" || value === "canceled" || value === "cancelled" || value === "aborted") return "FAILURE";
  return "UNKNOWN";
}

function failureReason(body) {
  const error = body && body.error;
  if (typeof error === "string" && error.trim()) return error.trim().slice(0, 512);
  if (isObject(error)) {
    for (const key of ["message", "detail", "code"]) {
      if (text(error[key])) return text(error[key]).slice(0, 512);
    }
  }
  return "Replicate prediction failed";
}

function imageURLs(body) {
  const output = body && body.output;
  const values = typeof output === "string" ? [output] : Array.isArray(output) ? output : [];
  const urls = [];
  for (const value of values) {
    if (text(value)) urls.push(text(value));
  }
  if (urls.length > MAX_IMAGE_COUNT) throw new Error("too many output images");
  return urls;
}

function predictionBody(task) {
  const data = isObject(task.data) ? { ...task.data } : {};
  const statuses = { NOT_START: "starting", SUBMITTED: "starting", QUEUED: "starting", IN_PROGRESS: "processing", SUCCESS: "succeeded", FAILURE: "failed" };
  data.id = task.task_id;
  data.status = statuses[task.status] || "processing";
  if (task.status === "FAILURE") data.error = task.fail_reason || data.error || "Replicate prediction failed";
  return data;
}

export const native = {
  createPrediction(ctx) {
    if (!ctx.body || ctx.body.kind !== "json" || !isObject(ctx.body.value)) throw new Error("JSON object required");
    if (!MODELS.includes(text(ctx.body.value.model))) throw new Error("unsupported Replicate model");
    return normalizeRequest({ body: ctx.body, model: ctx.body.value.model, operation: "generate" });
  },
  prediction(ctx, task) { return predictionBody(task); },
};

export const protocols = {
  openai_image: {
    decodeRequest: normalizeRequest,
    render(ctx, task) {
      const urls = imageURLs(task.data);
      if (!urls.length) throw new Error("Replicate prediction succeeded without an image");
      return { created: task.created_at, data: urls.map((url) => ({ url })) };
    },
  },
};

export function buildSubmitRequest(ctx) {
  const model = text(ctx.upstreamModel || ctx.model);
  if (!MODELS.includes(model)) throw new Error("unsupported Replicate upstream model: " + model);
  const req = ctx.requestBody;
  if (!isObject(req) || !isObject(req.input)) throw new Error("missing normalized Replicate input");
  const viaGateway = ctx.upstream && ctx.upstream.kind === "new_api";
  const url = ctx.baseUrl + (viaGateway ? "/replicate/v1/predictions" : "/v1/models/" + model + "/predictions");
  const body = viaGateway ? { model, input: req.input } : { input: req.input };
  const headers = { Authorization: ctx.authHeader };
  if (!viaGateway) headers.Prefer = "wait";
  return { url, method: "POST", headers, body };
}

export function parseSubmitResponse(ctx, response) {
  const body = response.body;
  if (!isObject(body) || !text(body.id)) throw new Error("Replicate prediction response has no id");
  const result = { taskId: body.id, taskData: body };
  const current = status(body);
  if (current === "SUCCESS") {
    if (!imageURLs(body).length) result.immediate = { status: "FAILURE", reason: "Replicate prediction succeeded without an image" };
    else result.immediate = { status: "SUCCESS", url: imageURLs(body)[0] };
  } else if (current === "FAILURE") result.immediate = { status: "FAILURE", reason: failureReason(body) };
  else if (current === "UNKNOWN") throw new Error("unrecognized Replicate prediction status: " + String(body.status));
  return result;
}

export function buildQueryRequest(ctx) {
  const viaGateway = ctx.upstream && ctx.upstream.kind === "new_api";
  const prefix = viaGateway ? "/replicate/v1/predictions/" : "/v1/predictions/";
  return { url: ctx.baseUrl + prefix + encodeURIComponent(ctx.taskId), method: "GET", headers: { Authorization: ctx.authHeader } };
}

export function parseTaskResult(ctx, body) {
  const current = status(body);
  if (current === "SUCCESS") {
    const urls = imageURLs(body);
    return urls.length ? { status: "SUCCESS", url: urls[0] } : { status: "FAILURE", reason: "Replicate prediction succeeded without an image" };
  }
  if (current === "FAILURE") return { status: "FAILURE", reason: failureReason(body) };
  return current === "UNKNOWN" ? { status: "UNKNOWN", reason: "unrecognized Replicate prediction status" } : { status: current };
}

export function extractUsage(ctx) {
  const amount = count(ctx.requestBody && ctx.requestBody.image_count, "image_count", MAX_IMAGE_COUNT);
  return { image_count: amount };
}

export function extractUsageOnSubmit(ctx, body) {
  return status(body) === "SUCCESS" ? { image_count: imageURLs(body).length } : {};
}

export function extractUsageOnComplete(task, result, body) {
  return result.status === "SUCCESS" ? { image_count: imageURLs(body).length } : {};
}
