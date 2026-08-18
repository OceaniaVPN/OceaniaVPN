1: import yaml from "js-yaml";
2: 
3: // ═══════════════════════════════════════════
4: //  УТИЛИТЫ
5: // ═══════════════════════════════════════════
6: export function safeBase64(data) {
7:   try {
8:     const clean = data.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
9:     const padded = clean + "=".repeat((4 - clean.length % 4) % 4);
10:     return atob(padded);
11:   } catch {
12:     return null;
13:   }
14: }
15: 
16: export function extractHeaders(content) {
17:   const meta = {};
18:   for (const line of content.split("\n")) {
19:     if (line.startsWith("#")) {
20:       const m = line.match(/^#([a-z0-9-]+):\s*(.+)$/i);
21:       if (m) meta[m[1]] = m[2].trim();
22:     }
23:   }
24:   return meta;
25: }
26: 
27: // ═══════════════════════════════════════════
28: //  YAML PROXY → URI (Clash / Mihomo)
29: // ═══════════════════════════════════════════
30: export function proxyToUri(p) {
31:   if (!p || !p.type) return null;
32:   const t = p.type.toLowerCase();
33:   const name = p.name || "Server";
34:   
35:   if (t === "vless") {
36:     const params = new URLSearchParams();
37:     if (p.network) params.set("type", p.network);
38:     if (p["ws-opts"]?.path) params.set("path", p["ws-opts"].path);
39:     if (p["ws-opts"]?.headers?.Host) params.set("host", p["ws-opts"].headers.Host);
40:     if (p["grpc-opts"]?.["grpc-service-name"]) params.set("serviceName", p["grpc-opts"]["grpc-service-name"]);
41:     if (p["reality-opts"]?.["public-key"]) params.set("pbk", p["reality-opts"]["public-key"]);
42:     if (p["reality-opts"]?.["short-id"]) params.set("sid", p["reality-opts"]["short-id"]);
43:     if (p.tls) params.set("security", "tls");
44:     else if (p["reality-opts"]) params.set("security", "reality");
45:     if (p.sni) params.set("sni", p.sni);
46:     if (p["client-fingerprint"]) params.set("fp", p["client-fingerprint"]);
47:     if (p.flow) params.set("flow", p.flow);
48:     const q = params.toString();
49:     return `vless://${p.uuid}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
50:   }
51:   
52:   if (t === "vmess") {
53:     const v = {
54:       v: "2", ps: name, add: p.server, port: p.port, id: p.uuid,
55:       aid: p.alterId || 0, net: p.network || "tcp", type: "none",
56:       host: p["ws-opts"]?.headers?.Host || "", path: p["ws-opts"]?.path || "",
57:       tls: p.tls ? "tls" : "", sni: p.sni || "",
58:     };
59:     return `vmess://${btoa(JSON.stringify(v))}`;
60:   }
61:   
62:   if (t === "trojan") {
63:     const params = new URLSearchParams();
64:     params.set("security", "tls");
65:     if (p.network) params.set("type", p.network);
66:     if (p["ws-opts"]?.path) params.set("path", p["ws-opts"].path);
67:     if (p["ws-opts"]?.headers?.Host) params.set("host", p["ws-opts"].headers.Host);
68:     if (p.sni) params.set("sni", p.sni);
69:     const q = params.toString();
70:     return `trojan://${p.password}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
71:   }
72:   
73:   if (t === "ss" || t === "shadowsocks") {
74:     const ui = btoa(`${p.cipher}:${p.password}`);
75:     return `ss://${ui}@${p.server}:${p.port}#${encodeURIComponent(name)}`;
76:   }
77:   
78:   if (t === "hysteria" || t === "hysteria2") {
79:     const params = new URLSearchParams();
80:     if (p.sni) params.set("sni", p.sni);
81:     if (p["obfs-password"]) params.set("obfs-password", p["obfs-password"]);
82:     params.set("upmbps", String(p.up || 100).replace(/\D/g, "") || "100");
83:     params.set("downmbps", String(p.down || 100).replace(/\D/g, "") || "100");
84:     const q = params.toString();
85:     return `hysteria2://${p.password}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
86:   }
87:   
88:   if (t === "tuic") {
89:     const params = new URLSearchParams();
90:     if (p.sni) params.set("sni", p.sni);
91:     if (p.alpn) params.set("alpn", Array.isArray(p.alpn) ? p.alpn.join(",") : p.alpn);
92:     if (p["congestion-controller"]) params.set("congestion_control", p["congestion-controller"]);
93:     const q = params.toString();
94:     return `tuic://${p.uuid}:${p.password}@${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
95:   }
96:   
97:   if (t === "wireguard" || t === "wg") {
98:     const params = new URLSearchParams();
99:     if (p["private-key"]) params.set("private_key", p["private-key"]);
100:     if (p["public-key"]) params.set("peer_public_key", p["public-key"]);
101:     if (p.ip) params.set("address", p.ip);
102:     const q = params.toString();
103:     return `wg://${p.server}:${p.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
104:   }
105:   
106:   return null;
107: }
108: 
109: // ═══════════════════════════════════════════
110: //  XRAY OUTBOUND → URI
111: // ═══════════════════════════════════════════
112: export function xrayToUri(ob) {
113:   if (!ob || !ob.protocol) return null;
114:   const proto = ob.protocol.toLowerCase();
115:   const name = ob.tag || "Server";
116:   const ss = ob.streamSettings || {};
117:   
118:   if (proto === "vless" && ob.settings?.vnext?.[0]) {
119:     const srv = ob.settings.vnext[0];
120:     const usr = srv.users?.[0];
121:     if (!usr) return null;
122:     const params = new URLSearchParams();
123:     if (ss.network) params.set("type", ss.network);
124:     if (ss.security) params.set("security", ss.security);
125:     if (ss.network === "ws") {
126:       if (ss.wsSettings?.path) params.set("path", ss.wsSettings.path);
127:       if (ss.wsSettings?.headers?.Host) params.set("host", ss.wsSettings.headers.Host);
128:     }
129:     if (ss.network === "grpc" && ss.grpcSettings?.serviceName) {
130:       params.set("serviceName", ss.grpcSettings.serviceName);
131:     }
132:     if (ss.realitySettings) {
133:       params.set("security", "reality");
134:       if (ss.realitySettings.serverName) params.set("sni", ss.realitySettings.serverName);
135:       if (ss.realitySettings.publicKey) params.set("pbk", ss.realitySettings.publicKey);
136:       if (ss.realitySettings.shortId) params.set("sid", ss.realitySettings.shortId);
137:     }
138:     if (ss.tlsSettings?.serverName) params.set("sni", ss.tlsSettings.serverName);
139:     if (usr.flow) params.set("flow", usr.flow);
140:     const q = params.toString();
141:     return `vless://${usr.id}@${srv.address}:${srv.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
142:   }
143:   
144:   if (proto === "vmess" && ob.settings?.vnext?.[0]) {
145:     const srv = ob.settings.vnext[0];
146:     const usr = srv.users?.[0];
147:     if (!usr) return null;
148:     const v = {
149:       v: "2", ps: name, add: srv.address, port: srv.port, id: usr.id,
150:       aid: usr.alterId || 0, net: ss.network || "tcp", type: "none",
151:       host: ss.wsSettings?.headers?.Host || "", path: ss.wsSettings?.path || "",
152:       tls: ss.security === "tls" ? "tls" : "",
153:     };
154:     return `vmess://${btoa(JSON.stringify(v))}`;
155:   }
156:   
157:   if (proto === "trojan" && ob.settings?.servers?.[0]) {
158:     const srv = ob.settings.servers[0];
159:     const params = new URLSearchParams();
160:     params.set("security", "tls");
161:     if (ss.network) params.set("type", ss.network);
162:     if (ss.tlsSettings?.serverName) params.set("sni", ss.tlsSettings.serverName);
163:     const q = params.toString();
164:     return `trojan://${srv.password}@${srv.address}:${srv.port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
165:   }
166:   
167:   if (proto === "shadowsocks" && ob.settings?.servers?.[0]) {
168:     const srv = ob.settings.servers[0];
169:     const ui = btoa(`${srv.method}:${srv.password}`);
170:     return `ss://${ui}@${srv.address}:${srv.port}#${encodeURIComponent(name)}`;
171:   }
172:   
173:   return null;
174: }
175: 
176: // ═══════════════════════════════════════════
177: //  SING-BOX OUTBOUND → URI (Happ / Hiddify)
178: // ═══════════════════════════════════════════
179: export function singboxToUri(ob) {
180:   if (!ob || !ob.type || !ob.server || !ob.server_port) return null;
181:   const t = ob.type.toLowerCase();
182:   const name = ob.tag || "Server";
183:   const server = ob.server;
184:   const port = ob.server_port;
185:   
186:   if (t === "vless") {
187:     const params = new URLSearchParams();
188:     const tr = ob.transport || {};
189:     const tls = ob.tls || {};
190:     if (tr.type) params.set("type", tr.type);
191:     if (tr.type === "ws") {
192:       if (tr.path) params.set("path", tr.path);
193:       if (tr.headers?.Host) params.set("host", tr.headers.Host);
194:     }
195:     if (tr.type === "grpc" && tr.service_name) params.set("serviceName", tr.service_name);
196:     if (tls.enabled) {
197:       params.set("security", tls.reality?.enabled ? "reality" : "tls");
198:       if (tls.server_name) params.set("sni", tls.server_name);
199:       if (tls.reality?.public_key) params.set("pbk", tls.reality.public_key);
200:       if (tls.reality?.short_id) params.set("sid", tls.reality.short_id);
201:       if (tls.utls?.fingerprint) params.set("fp", tls.utls.fingerprint);
202:     }
203:     if (ob.flow) params.set("flow", ob.flow);
204:     const q = params.toString();
205:     return `vless://${ob.uuid}@${server}:${port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
206:   }
207:   
208:   if (t === "vmess") {
209:     const tr = ob.transport || {};
210:     const tls = ob.tls || {};
211:     const v = {
212:       v: "2", ps: name, add: server, port, id: ob.uuid,
213:       aid: ob.alter_id || 0, net: tr.type || "tcp", type: "none",
214:       host: tr.headers?.Host || "", path: tr.path || "",
215:       tls: tls.enabled ? "tls" : "", sni: tls.server_name || "",
216:     };
217:     return `vmess://${btoa(JSON.stringify(v))}`;
218:   }
219:   
220:   if (t === "trojan") {
221:     const params = new URLSearchParams();
222:     const tls = ob.tls || {};
223:     params.set("security", "tls");
224:     if (ob.transport?.type) params.set("type", ob.transport.type);
225:     if (ob.transport?.path) params.set("path", ob.transport.path);
226:     if (ob.transport?.headers?.Host) params.set("host", ob.transport.headers.Host);
227:     if (tls.server_name) params.set("sni", tls.server_name);
228:     const q = params.toString();
229:     return `trojan://${ob.password}@${server}:${port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
230:   }
231:   
232:   if (t === "shadowsocks") {
233:     const ui = btoa(`${ob.method}:${ob.password}`);
234:     return `ss://${ui}@${server}:${port}#${encodeURIComponent(name)}`;
235:   }
236:   
237:   if (t === "hysteria2" || t === "hysteria") {
238:     const params = new URLSearchParams();
239:     if (ob.tls?.server_name) params.set("sni", ob.tls.server_name);
240:     if (ob.obfs?.password) params.set("obfs-password", ob.obfs.password);
241:     const q = params.toString();
242:     return `hysteria2://${ob.password}@${server}:${port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
243:   }
244:   
245:   if (t === "tuic") {
246:     const params = new URLSearchParams();
247:     if (ob.tls?.server_name) params.set("sni", ob.tls.server_name);
248:     if (ob.congestion_control) params.set("congestion_control", ob.congestion_control);
249:     const q = params.toString();
250:     return `tuic://${ob.uuid}:${ob.password}@${server}:${port}${q ? "?" + q : ""}#${encodeURIComponent(name)}`;
251:   }
252:   
253:   return null;
254: }
255: 
256: // ═══════════════════════════════════════════
257: //  ПАРСЕРЫ ФОРМАТОВ
258: // ═══════════════════════════════════════════
259: export function parseVlessList(content) {
260:   const uris = [];
261:   for (const line of content.split("\n")) {
262:     const l = line.trim();
263:     // 🔥 ИСПРАВЛЕНО: экранированы слеши в регулярном выражении
264:     if (l && !l.startsWith("#") && /^[a-z0-9]+:\/\//i.test(l)) {
265:       uris.push(l);
266:     }
267:   }
268:   return { ok: true, uris, metadata: extractHeaders(content) };
269: }
270: 
271: export function parseBase64(content) {
272:   const decoded = safeBase64(content.replace(/\s/g, ""));
273:   if (!decoded) return { ok: false, error: "Invalid base64" };
274:   return parseVlessList(decoded);
275: }
276: 
277: export function parseYaml(content) {
278:   try {
279:     const cfg = yaml.load(content);
280:     const uris = [];
281:     const proxies = cfg?.proxies || [];
282:     for (const p of proxies) {
283:       const uri = proxyToUri(p);
284:       if (uri) uris.push(uri);
285:     }
286:     return {
287:       ok: true,
288:       uris,
289:       metadata: extractHeaders(content),
290:       title: cfg?.["profile-title"] || cfg?.name,
291:       interval: cfg?.["profile-update-interval"],
292:     };
293:   } catch (e) {
294:     return { ok: false, error: `YAML: ${e.message}` };
295:   }
296: }
297: 
298: export function parseJson(content) {
299:   try {
300:     const data = JSON.parse(content);
301:     const uris = [];
302:     
303:     const tryConvert = (ob) => {
304:       let uri = singboxToUri(ob);
305:       if (!uri) uri = xrayToUri(ob);
306:       if (!uri) uri = proxyToUri(ob);
307:       return uri;
308:     };
309: 
310:     // 1. { outbounds: [...] } — Одиночный Xray / Sing-box конфиг
311:     if (Array.isArray(data?.outbounds)) {
312:       const skip = ["direct", "block", "dns", "selector", "urltest", "fallback"];
313:       for (const ob of data.outbounds) {
314:         if (skip.includes(ob?.type) || skip.includes(ob?.protocol)) continue;
315:         const uri = tryConvert(ob);
316:         if (uri) uris.push(uri);
317:       }
318:     }
319: 
320:     // 2. Hiddify: { configs: [{ url }] }
321:     if (Array.isArray(data?.configs)) {
322:       for (const c of data.configs) {
323:         if (typeof c === "string") uris.push(c);
324:         else if (c?.url) uris.push(c.url);
325:         else if (c?.config) uris.push(c.config);
326:       }
327:     }
328: 
329:     // 3. Массив строк или объектов (включая массив полных конфигов Hiddify/Xray)
330:     if (Array.isArray(data)) {
331:       for (const item of data) {
332:         if (typeof item === "string" && item.includes("://")) {
333:           uris.push(item);
334:         } else if (item?.type) {
335:           const uri = tryConvert(item);
336:           if (uri) uris.push(uri);
337:         } else if (Array.isArray(item?.outbounds)) {
338:           // 🔥 FIX: Поддержка массива полных конфигов
339:           const skip = ["direct", "block", "dns", "selector", "urltest", "fallback"];
340:           for (const ob of item.outbounds) {
341:             if (skip.includes(ob?.type) || skip.includes(ob?.protocol)) continue;
342:             const uri = tryConvert(ob);
343:             if (uri) uris.push(uri);
344:           }
345:         }
346:       }
347:     }
348: 
349:     // 4. Один объект (без outbounds на верхнем уровне, но с type)
350:     if (data?.type && !Array.isArray(data)) {
351:       const uri = tryConvert(data);
352:       if (uri) uris.push(uri);
353:     }
354: 
355:     if (uris.length === 0) {
356:       return { ok: false, error: "JSON не содержит распознаваемых конфигов" };
357:     }
358: 
359:     // Удаляем возможные дубликаты URI
360:     const uniqueUris = [...new Set(uris)];
361:     return { ok: true, uris: uniqueUris, metadata: {} };
362:   } catch (e) {
363:     return { ok: false, error: `JSON: ${e.message}` };
364:   }
365: }
366: 
367: export function parseCrypt(content) {
368:   // 🔥 ИСПРАВЛЕНО: экранированы слеши в регулярном выражении
369:   const m = content.match(/^crypt[45]:\/\/(.+)$/i);
370:   if (!m) return { ok: false, error: "Некорректный crypt формат" };
371:   const decoded = safeBase64(m[1]);
372:   if (decoded && decoded.includes("://")) {
373:     return parseVlessList(decoded);
374:   }
375:   return {
376:     ok: false,
377:     error: `⚠️ <b>crypt5/crypt4</b> — зашифрованный формат Happ/Hiddify\n\n` +
378:            `Требуется AES-ключ для дешифровки.\n\n` +
379:            `💡 <b>Решение:</b> открой ссылку в Happ или Hiddify → экспортируй как обычную vless подписку → отправь мне снова.`
380:   };
381: }
// ═══════════════════════════════════════════
// HTML → сбор конфигов со страницы
// ═══════════════════════════════════════════

// Все поддерживаемые схемы прокси-протоколов
const PROXY_SCHEMES = [
  "vless", "vmess", "trojan", "ss", "ssr",
  "hysteria", "hysteria2", "hy2", "tuic", "wg", "wireguard",
  "socks", "socks5", "http",
];

// Regex для "голых" URI прямо в тексте/HTML (в атрибутах, тегах <a>, <code>, <pre>, JSON внутри <script> и т.д.)
// Берём непрерывный кусок без пробелов/кавычек/угловых скобок после схемы.
function buildProxyUriRegex() {
  const schemes = PROXY_SCHEMES.join("|");
  // допускаем схему://..., останавливаемся на пробеле, кавычке, <, >, ), запятой-разделителе HTML-энтити
  return new RegExp(`(?:${schemes}):\\/\\/[^\\s"'<>\\)\\]]+`, "gi");
}

// Regex для ссылок на подписки/сырые конфиги (обычные http/https-ссылки на .txt, /sub, /raw, base64-эндпоинты и т.п.)
function buildSubLinkRegex() {
  return /https?:\/\/[^\s"'<>\)\]]+/gi;
}

// Отсекаем "мусорные" http(s)-ссылки — картинки, стили, соцсети, сама страница и т.д.
const SUB_LINK_IGNORE = /\.(png|jpe?g|gif|svg|webp|ico|css|woff2?|ttf|map)(\?|#|$)/i;
const SUB_LINK_IGNORE_HOSTS = /(github\.com\/(?!.*\/raw\/)|githubusercontent\.com\/.*\.md$|twitter\.com|t\.me\/(?!.*[?&#]|.*\/joinchat)|youtube\.com|vk\.com|facebook\.com|instagram\.com)/i;

// Эвристика "похоже на ссылку с конфигами": содержит характерные слова/паттерны в пути
const SUB_LINK_LIKELY = /(sub|config|clash|singbox|sing-box|v2ray|xray|proxy|nodes?|link|raw\.githubusercontent|\/api\/|token=|\.ya?ml($|\?)|\.json($|\?)|\.txt($|\?))/i;

function stripHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// Достаём текстовое содержимое <pre>/<code> отдельно — там чаще всего лежат
// подписки/конфиги, которые сайт показывает "как есть"
function extractCodeBlocks(html) {
  const blocks = [];
  const re = /<(pre|code|textarea)[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const text = stripHtmlEntities(m[2].replace(/<[^>]+>/g, ""));
    if (text.trim()) blocks.push(text);
  }
  return blocks;
}

/**
 * Разбирает произвольный HTML-документ и достаёт из него:
 *  - прямые прокси-URI (vless/vmess/trojan/ss/...)
 *  - ссылки на подписки/сырые конфиги (https://.../sub, .../raw/..., .txt, .yaml и т.п.)
 *  - base64-блоки внутри <pre>/<code>, которые при декодировании дают список URI
 *
 * @param {string} html  исходный HTML
 * @param {string} [pageUrl]  URL страницы (для резолва относительных ссылок, если понадобится)
 */
export function parseHtml(html, pageUrl) {
  if (!html || typeof html !== "string") {
    return { ok: false, error: "Пустой HTML" };
  }

  const uris = new Set();
  const subLinks = new Set();

  const uriRe = buildProxyUriRegex();
  const linkRe = buildSubLinkRegex();

  // 1. Прямые прокси-URI по всему документу (включая атрибуты href, текст, JS-объекты в <script>)
  const cleanedHtml = stripHtmlEntities(html);
  for (const match of cleanedHtml.matchAll(uriRe)) {
    uris.add(match[0].replace(/[.,;]+$/, "")); // отсечь хвостовую пунктуацию
  }

  // 2. Блоки <pre>/<code>/<textarea> — частый способ показать подписку на странице
  for (const block of extractCodeBlocks(html)) {
    // 2a. Построчный список URI
    const listResult = parseVlessList(block);
    if (listResult.ok) {
      for (const u of listResult.uris) uris.add(u);
    }
    // 2b. Целиком base64-блок (подписка одним blob'ом)
    if (!/:\/\//.test(block)) {
      const b64Result = parseBase64(block);
      if (b64Result.ok) {
        for (const u of b64Result.uris) uris.add(u);
      }
    }
  }

  // 3. Ссылки, вероятно ведущие на подписки/файлы конфигов (для последующей докачки ботом)
  for (const match of cleanedHtml.matchAll(linkRe)) {
    const url = match[0].replace(/[.,;]+$/, "");
    if (SUB_LINK_IGNORE.test(url)) continue;
    if (SUB_LINK_IGNORE_HOSTS.test(url)) continue;
    if (SUB_LINK_LIKELY.test(url) || /\/raw\//.test(url)) {
      subLinks.add(url);
    }
  }

  // GitHub blob-ссылки → нормализуем в raw, чтобы бот сразу мог их скачать
  const normalizedSubLinks = [...subLinks].map((u) => {
    const blobMatch = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i);
    if (blobMatch) {
      return `https://raw.githubusercontent.com/${blobMatch[1]}/${blobMatch[2]}/${blobMatch[3]}`;
    }
    return u;
  });

  if (uris.size === 0 && normalizedSubLinks.length === 0) {
    return { ok: false, error: "На странице не найдено конфигов или ссылок на подписки" };
  }

  return {
    ok: true,
    uris: [...uris],
    subLinks: normalizedSubLinks,
    metadata: extractHeaders(html),
  };
}

/**
 * Комбинированный разбор: качает URL, определяет тип содержимого
 * (HTML / plain-list / base64 / yaml / json) и парсит соответствующим парсером.
 * Если это HTML со ссылками на подписки — рекурсивно докачивает их (глубина 1,
 * чтобы не улететь в бесконечный обход чужого сайта).
 *
 * @param {string} url
 * @param {(u: string) => Promise<string>} fetcher  функция скачивания текста по URL (передаётся ботом)
 * @param {number} [depth]
 */
export async function parseUrl(url, fetcher, depth = 0) {
  let content;
  try {
    content = await fetcher(url);
  } catch (e) {
    return { ok: false, error: `Не удалось скачать: ${e.message}` };
  }

  const trimmed = content.trim();
  const looksLikeHtml = /^<!doctype html|^<html[\s>]/i.test(trimmed) || /<\/html>/i.test(trimmed);

  if (looksLikeHtml) {
    const htmlResult = parseHtml(content, url);
    if (!htmlResult.ok) return htmlResult;

    let allUris = [...htmlResult.uris];

    if (depth === 0) {
      for (const sub of htmlResult.subLinks.slice(0, 10)) { // ограничение, чтобы не спамить запросами
        const nested = await parseUrl(sub, fetcher, depth + 1);
        if (nested.ok) allUris.push(...nested.uris);
      }
    }

    const uniqueUris = [...new Set(allUris)];
    if (uniqueUris.length === 0) {
      return { ok: false, error: "Конфиги не найдены ни на странице, ни по вложенным ссылкам" };
    }
    return { ok: true, uris: uniqueUris, metadata: htmlResult.metadata };
  }

  // Не HTML — пробуем как обычную подписку по очереди
  if (/^crypt[45]:\/\//i.test(trimmed)) return parseCrypt(trimmed);
  if (/^[a-z0-9]+:\/\//i.test(trimmed) || trimmed.split("\n").some((l) => /^[a-z0-9]+:\/\//i.test(l.trim()))) {
    return parseVlessList(trimmed);
  }
  try {
    JSON.parse(trimmed);
    return parseJson(trimmed);
  } catch { /* not json */ }
  if (/^proxies:|^proxy-groups:/m.test(trimmed)) {
    return parseYaml(trimmed);
  }
  const b64 = parseBase64(trimmed);
  if (b64.ok) return b64;

  return { ok: false, error: "Неизвестный формат содержимого по ссылке" };
}

