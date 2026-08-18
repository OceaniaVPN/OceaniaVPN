1: import {
2:   parseVlessList, parseBase64, parseYaml, parseJson, parseCrypt, safeBase64
3: } from "./parsers.js";
4: import { escapeHtml } from "./config.js";
5: import { TARGET_USER_AGENTS } from "./useragents.js";
6:
7: // ═══════════════════════════════════════════
8: //   ГЛОБАЛЬНЫЙ ЧЕРНЫЙ СПИСОК ДОМЕНОВ
9: // ═══════════════════════════════════════════
10: const BLOCKED_DOMAINS = [
11:   "okeaniavpn.dimastekolnikov1.workers.dev",
12:   "sub.chkav-vpn.workers.dev"
13: ];
14:
15: // ═══════════════════════════════════════════
16: //  🛡 ПРОВЕРКА НА ЗАГЛУШКУ (АГРЕССИВНАЯ)
17: // ══════════════════════════════════════════
18: function isStubResponse(text) {
19:   if (!text) return true;
20:   const stubs = [
21:     "0.0.0.0",
22:     "00000000-0000",
23:     "127.0.0.1",
24:     "localhost",
25:     "App not supported",
26:     "not supported",
27:     "Unsupported app",
28:     "invalid subscription",
29:     "subscription not found"
30:   ];
31:   return stubs.some(s => text.includes(s));
32: }
33:
34: // ═══════════════════════════════════════════
35: //  ⏱ HTTP С ТАЙМАУТОМ
36: // ═══════════════════════════════════════════
37: async function fetchWithTimeout(url, options, timeoutMs = 15000) {
38:   const controller = new AbortController();
39:   const timeout = setTimeout(() => controller.abort(), timeoutMs);
40:   try {
41:     return await fetch(url, { ...options, signal: controller.signal });
42:   } finally {
43:     clearTimeout(timeout);
44:   }
45: }
46:
47: // ═══════════════════════════════════════════
48: //  🔄 HTTP С РЕДИРЕКТАМИ
49: // ═══════════════════════════════════════════
50: async function fetchWithRedirects(url, headers, max = 5) {
51:   let currentUrl = url;
52:
53:   for (let i = 0; i < max; i++) {
54:     const res = await fetchWithTimeout(
55:       currentUrl,
56:       { method: "GET", headers, redirect: "manual" },
57:       15000
58:     );
59:
60:     if ([301, 302, 303, 307, 308].includes(res.status)) {
61:       const loc = res.headers.get("location");
62:       if (!loc) return res;
63:
64:       currentUrl = loc.startsWith("/")
65:         ? `${new URL(currentUrl).protocol}//${new URL(currentUrl).host}${loc}`
66:         : loc;
67:
68:       const redirectTarget = extractRedirectTarget(currentUrl);
69:       if (redirectTarget) currentUrl = redirectTarget;
70:
71:       continue;
72:     }
73:
74:     return res;
75:   }
76:
77:   return await fetchWithTimeout(currentUrl, { method: "GET", headers }, 15000);
78: }
79:
80: // ═══════════════════════════════════════════
81: //  🎯 ИЗВЛЕЧЕНИЕ РЕДИРЕКТА
82: // ═══════════════════════════════════════════
83: function extractRedirectTarget(url) {
84:   try {
85:     const urlObj = new URL(url);
86:
87:     if (urlObj.pathname.includes("happ-redirect") || urlObj.pathname.includes("redirect")) {
88:       return urlObj.searchParams.get("url") ||
89:              urlObj.searchParams.get("sub") ||
90:              urlObj.searchParams.get("link") ||
91:              urlObj.searchParams.get("target") || null;
92:     }
93:
94:     return urlObj.searchParams.get("url") || null;
95:   } catch {
96:     return null;
97:   }
98: }
99:
100: // ═══════════════════════════════════════════
101: //  🔥 АГРЕССИВНЫЙ ПОИСК URL ИЗ HTML (ПОЛНАЯ ВЕРСИЯ)
102: // ═══════════════════════════════════════════
103: function extractAllUrlsFromHtml(html, originalUrl) {
104:   const foundUrls = new Set();
105:
106:   // 1. happ:// deep-links
107:   const happLinks = html.match(/happ:\/\/[^"'\s]+/gi) || [];
108:   for (const link of happLinks) {
109:     const decoded = decodeURIComponent(link.replace("happ://", ""));
110:
111:     // а) Прямая ссылка
112:     const direct = decoded.match(/https?:\/\/[^\s]+/gi);
113:     if (direct && !direct[0].includes("0.0.0.0")) {
114:       foundUrls.add(direct[0]);
115:     }
116:
117:     // б) base64 payload
118:     const b64 = decoded.match(/happ:\/\/[a-z]*\/?([A-Za-z0-9+/=_-]{20,})/i);
119:     if (b64) {
120:       const d = safeBase64(b64[1]);
121:       if (d) {
122:         (d.match(/https?:\/\/[^\s"'\\]+/gi) || []).forEach(u => {
123:           if (!u.includes("0.0.0.0")) foundUrls.add(u);
124:         });
125:       }
126:     }
127:   }
128:
129:   // 2. data-атрибуты кнопок
130:   const dataAttrs = html.match(/data-(?:url|link|sub|subscription|config|clipboard-text)=["']([^"']+)["']/gi) || [];
131:   for (const attr of dataAttrs) {
132:     const m = attr.match(/=["']([^"']+)["']/);
133:     if (m && m[1].startsWith("http") && !m[1].includes("0.0.0.0")) {
134:       foundUrls.add(m[1]);
135:     }
136:   }
137:
138:   // 3. onclick обработчики
139:   const onclickMatches = html.match(/onclick=["'][^"']*?(https?:\/\/[^"'\s]+)[^"']*?["']/gi) || [];
140:   for (const m of onclickMatches) {
141:     const urlMatch = m.match(/https?:\/\/[^"'\s]+/);
142:     if (urlMatch && !urlMatch[0].includes("0.0.0.0")) {
143:       foundUrls.add(urlMatch[0]);
144:     }
145:   }
146:
147:   // 4. JavaScript переменные
148:   const jsVars = html.match(/(?:var|let|const)\s+(?:url|link|sub|subscription|config)\s*=\s*["']([^"']+)["']/gi) || [];
149:   for (const v of jsVars) {
150:     const m = v.match(/=\s*["']([^"']+)["']/);
151:     if (m && m[1].startsWith("http") && !m[1].includes("0.0.0.0")) {
152:       foundUrls.add(m[1]);
153:     }
154:   }
155:
156:   // 5. JSON в HTML
157:   const jsonInHtml = html.match(/<script[^>]*>\s*(?:var\s+config\s*=)?\s*({[^]*?})\s*<\/script>/gi) || [];
158:   for (const block of jsonInHtml) {
159:     try {
160:       const jsonMatch = block.match(/{[^]*?}/);
161:       if (jsonMatch) {
162:         const obj = JSON.parse(jsonMatch[0]);
163:         if (obj.url) foundUrls.add(obj.url);
164:         if (obj.subscription) foundUrls.add(obj.subscription);
165:         if (obj.config) foundUrls.add(obj.config);
166:         if (obj.link) foundUrls.add(obj.link);
167:       }
168:     } catch {}
169:   }
170:
171:   // 6. Base64 encoded URL
172:   const b64InHtml = html.match(/["']([A-Za-z0-9+/]{50,}={0,2})["']/g) || [];
173:   for (const b64 of b64InHtml) {
174:     try {
175:       const clean = b64.replace(/["']/g, "");
176:       const decoded = safeBase64(clean);
177:       if (decoded && decoded.startsWith("http")) {
178:         foundUrls.add(decoded);
179:       }
180:     } catch {}
181:   }
182:
183:   // 7. Стандартные паттерны (JS редиректы, meta refresh)
184:   const patterns = [
185:     /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
186:     /window\.location\.replace\(["']([^"']+)["']/i,
187:     /window\.open\(["']([^"']+)["']/i,
188:     /content=["'][^"']*url=([^"']+)["']/i,
189:     /href=["'](https?:\/\/[^"']+\.php\?[^"']+)["']/i,
190:     /action=["'](https?:\/\/[^"']+)["']/i,
191:   ];
192:
193:   for (const p of patterns) {
194:     const matches = html.match(p);
195:     if (matches && matches[1]) {
196:       let url = matches[1].replace(/&amp;/g, "&");
197:       if (url.startsWith("happ://")) continue;
198:       if (url.startsWith("/")) {
199:         try {
200:           const base = new URL(originalUrl);
201:           url = `${base.protocol}//${base.host}${url}`;
202:         } catch {}
203:       }
204:       if (url.startsWith("http") && url !== originalUrl && !url.includes("0.0.0.0")) {
205:         foundUrls.add(url);
206:       }
207:     }
208:   }
209:
210:   // 8. Ссылки в <a> тегах
211:   const linkTags = html.match(/<a[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>/gi) || [];
212:   for (const tag of linkTags) {
213:     const m = tag.match(/href=["'](https?:\/\/[^"']+)["']/i);
214:     if (m) {
215:       const href = m[1];
216:       if ((href.includes("sub") || href.includes("token") || href.includes("config") || href.includes("uuid")) && !href.includes("0.0.0.0")) {
217:         foundUrls.add(href);
218:       }
219:     }
220:   }
221:
222:   // 9. Любая ссылка с /sub, token=, key=, uuid=
223:   const anySub = html.match(/["'](https?:\/\/[^"'\s]*\/sub[^"'\s]*)["']/gi) ||
224:                  html.match(/["'](https?:\/\/[^"'\s]*[?&](?:token|key|uuid|id)=[^"'\s]+)["']/gi) || [];
225:   for (const s of anySub) {
226:     const url = s.replace(/["']/g, "").replace(/&amp;/g, "&");
227:     if (!url.includes("0.0.0.0")) foundUrls.add(url);
228:   }
229:
230:   // 10. Простые HTTP ссылки (резерв)
231:   if (foundUrls.size === 0) {
232:     const simpleLinks = html.match(/https?:\/\/[^\s"'<>]{20,}/gi) || [];
233:     for (const link of simpleLinks) {
234:       if ((link.includes("sub") || link.includes("token") || link.includes("config")) && !link.includes("0.0.0.0")) {
235:         foundUrls.add(link);
236:       }
237:     }
238:   }
239:
240:   return Array.from(foundUrls).filter(url =>
241:     url !== originalUrl &&
242:     url.startsWith("http") &&
243:     !url.includes("0.0.0.0") &&
244:     !url.includes("00000000-0000")
245:   );
246: }
247:
248: // ══════════════════════════════════════════
249: //  🔥 ОСНОВНОЙ FETCH С ПЕРЕБОРОМ ВСЕХ UA
250: // ═══════════════════════════════════════════
251: async function fetchSubscription(url) {
252:   try {
253:     const lowerUrl = url.toLowerCase();
254:     if (BLOCKED_DOMAINS.some(domain => lowerUrl.includes(domain.toLowerCase()))) {
255:       return { ok: false, error: "🚫 Домен заблокирован", attempts: 0 };
256:     }
257: 
258:     const redirectTarget = extractRedirectTarget(url);
259:     const actualUrl = redirectTarget || url;
260:     
261:     if (redirectTarget) {
262:       console.log(`[Decoder] Redirect: ${url} -> ${redirectTarget}`);
263:     }
264:     
265:     console.log(`[Decoder] Target URL: ${actualUrl}`);
266:     console.log(`[Decoder] Will try ${TARGET_USER_AGENTS.length} User-Agents`);
267:     
268:     let lastError = "Неизвестная ошибка";
269:     let attempts = 0;
270: 
271:     // 🔥 ПЕРЕБОР ВСЕХ USER-AGENTS
272:     for (let i = 0; i < TARGET_USER_AGENTS.length; i++) {
273:       attempts = i + 1;
274:       const ua = TARGET_USER_AGENTS[i];
275:       console.log(`\n[Decoder] === Attempt ${attempts}/${TARGET_USER_AGENTS.length} ===`);
276:       console.log(`[Decoder] UA: ${ua}`);
277:       
278:       const headers = { 
279:         "User-Agent": ua,
280:         "Accept": "*/*",
281:         "Accept-Language": "en-US,en;q=0.9,ru;q=0.8",
282:         "Connection": "keep-alive",
283:         "X-Happ-App": ua.includes("Happ") ? "Happ" : undefined,
284:         "X-Happ-Platform": ua.includes("Android") ? "android" : (ua.includes("iOS") ? "ios" : "windows")
285:       };
286: 
287:       try {
288:         const res = await fetchWithRedirects(actualUrl, headers);
289:         console.log(`[Decoder] Response status: ${res.status}`);
290:         
291:         if (!res.ok) {
292:           lastError = `HTTP ${res.status}`;
293:           console.log(`[Decoder] ❌ HTTP error, trying next UA...`);
294:           continue;
295:         }
296:         
297:         const text = await res.text();
298:         const ct = res.headers.get("content-type") || "";
299:         console.log(`[Decoder] Content-Type: ${ct}`);
300:         console.log(`[Decoder] Response length: ${text.length} chars`);
301: 
302:         // 🔥 ПРОВЕРКА НА ЗАГЛУШКУ
303:         if (isStubResponse(text)) {
304:           console.log(`[Decoder] ⚠️ Stub detected (0.0.0.0 or App not supported), trying next UA...`);
305:           lastError = "Сервер вернул заглушку (0.0.0.0 / App not supported)";
306:           continue;
307:         }
308: 
309:         const isHtml = ct.includes("text/html") || 
310:                        text.trim().startsWith("<!DOCTYPE") || 
311:                        text.trim().startsWith("<html") ||
312:                        text.includes("<body") ||
313:                        text.includes("<script");
314: 
315:         if (isHtml) {
316:           console.log(`[Decoder] HTML detected, searching for real subscription URL...`);
317:           const allUrls = extractAllUrlsFromHtml(text, url);
318:           console.log(`[Decoder] Found ${allUrls.length} URLs in HTML:`, allUrls);
319:           
320:           if (allUrls.length > 0) {
321:             const allContents = [];
322:             for (const subUrl of allUrls) {
323:               try {
324:                 console.log(`[Decoder] Fetching sub URL: ${subUrl}`);
325:                 const subRes = await fetchWithRedirects(subUrl, headers);
326:                 if (subRes.ok) {
327:                   const subText = await subRes.text();
328:                   const subCt = subRes.headers.get("content-type") || "";
329:                   
330:                   if (subCt.includes("text/html") || subText.trim().startsWith("<")) {
331:                     const nestedUrls = extractAllUrlsFromHtml(subText, subUrl);
332:                     for (const nestedUrl of nestedUrls) {
333:                       try {
334:                         const nestedRes = await fetchWithRedirects(nestedUrl, headers);
335:                         if (nestedRes.ok) {
336:                           const nestedText = await nestedRes.text();
337:                           if (!isStubResponse(nestedText)) {
338:                             allContents.push(nestedText);
339:                           }
340:                         }
341:                       } catch (e) {
342:                         console.log(`[Decoder] Failed nested URL ${nestedUrl}:`, e.message);
343:                       }
344:                     }
345:                   } else {
346:                     if (!isStubResponse(subText)) {
347:                       allContents.push(subText);
348:                     }
349:                   }
350:                 }
351:               } catch (e) {
352:                 console.log(`[Decoder] Failed sub URL ${subUrl}:`, e.message);
353:               }
354:             }
355:             
356:             if (allContents.length > 0) {
357:               console.log(`[Decoder] ✅ Success! Got ${allContents.length} contents`);
358:               return { ok: true, content: allContents.join("\n"), contentType: "text/plain", attempts };
359:             }
360:           }
361:           
362:           lastError = "HTML не содержит рабочей подписки";
363:           console.log(`[Decoder] ⚠️ No working subscription found in HTML, trying next UA...`);
364:           continue;
365:         } else {
366:           console.log(`[Decoder] ✅ SUCCESS! Got non-HTML content`);
367:           return { ok: true, content: text, contentType: ct, attempts };
368:         }
369:       } catch (e) {
370:         console.log(`[Decoder] ⚠️ Error: ${e.message}, trying next UA...`);
371:         lastError = e.message;
372:         continue;
373:       }
374:     }
375: 
376:     console.log(`\n[Decoder] === ALL UA FAILED ===`);
377:     console.log(`[Decoder] Last error: ${lastError}`);
378:     
379:     return {
380:       ok: false,
381:       error: `❌ <b>Не удалось получить подписку</b>\n\nБот попробовал <b>${attempts}</b> User-Agent'ов, но сервер каждый раз возвращал заглушку "App not supported" или ошибку.\n\nПоследняя ошибка: <code>${escapeHtml(lastError)}</code>\n\n💡 <b>Единственное решение:</b>\n1. Открой эту ссылку в браузере на телефоне\n2. Нажми кнопку <b>"Добавить подписку"</b>\n3. Скопируй ссылку (она должна содержать <code>token=</code>)\n4. Отправь эту ссылку мне напрямую`,
382:       attempts
383:     };
384: 
385:   } catch (e) {
386:     if (e.name === "AbortError") return { ok: false, error: "Таймаут (15 сек)", attempts: 0 };
387:     return { ok: false, error: `Ошибка сети: ${e.message}`, attempts: 0 };
388:   }
389: }
390: 
391: // ═══════════════════════════════════════════
392: //  🕵️ ДЕТЕКТОР ФОРМАТА
393: // ═══════════════════════════════════════════
394: function detectFormat(content) {
395:   const c = content.trim();
396:   if (!c) return "empty";
397:   
398:   if (c.startsWith("crypt5://") || c.startsWith("crypt4://")) return "crypt";
399:   
400:   if (c.includes("<!DOCTYPE") || c.includes("<html") || c.includes("<body") || c.includes("<script")) {
401:     return "html";
402:   }
403:   
404:   if (/^[A-Za-z0-9+/=\-_]+$/.test(c.replace(/\s/g, "")) && c.length > 40) {
405:     const decoded = safeBase64(c);
406:     if (decoded && decoded.includes("://")) return "base64";
407:   }
408:   
409:   if (c.startsWith("{") || c.startsWith("[")) {
410:     try { JSON.parse(c); return "json"; } catch {}
411:   }
412:   
413:   if (c.includes("proxies:") || c.includes("proxy-groups:") || /mixed-port:\s*\d+/.test(c)) {
414:     return "yaml";
415:   }
416:   
417:   const lines = c.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
418:   if (lines.length > 0 && lines.some(l => /^(vless|vmess|trojan|ss|hysteria|tuic|wireguard):\/\//i.test(l))) {
419:     const fakeCount = lines.filter(l => l.includes("0.0.0.0") || l.includes("00000000-0000")).length;
420:     if (fakeCount > 0) return "html";
421:     return "vless-list";
422:   }
423:   
424:   return "unknown";
425: }
426: 
427: // ═══════════════════════════════════════════
428: //  🚀 ГЛАВНАЯ ФУНКЦИЯ ДЕКОДЕРА
429: // ═══════════════════════════════════════════
430: export async function decodeSubscription(url) {
431:   const result = await fetchSubscription(url);
432:   
433:   if (!result.ok) {
434:     return { ok: false, error: result.error, attempts: result.attempts || 0 };
435:   }
436:   
437:   if (isStubResponse(result.content)) {
438:     return {
439:       ok: false,
440:       error: `❌ <b>Обнаружена заглушка!</b>\n\nСервер вернул фейковые ключи (0.0.0.0) или "App not supported".\n\n💡 Открой ссылку в браузере → нажми "Добавить подписку" → скопируй прямую ссылку`,
441:       attempts: result.attempts || 0
442:     };
443:   }
444:   
445:   const format = detectFormat(result.content);
446:   console.log(`[Decoder] Format: ${format}, length: ${result.content.length}`);
447:   
448:   let parseResult;
449:   switch (format) {
450:     case "vless-list": parseResult = parseVlessList(result.content); break;
451:     case "base64": parseResult = parseBase64(result.content); break;
452:     case "yaml": parseResult = parseYaml(result.content); break;
453:     case "json": parseResult = parseJson(result.content); break;
454:     case "crypt": parseResult = parseCrypt(result.content); break;
455:     case "empty": parseResult = { ok: false, error: "Пустая подписка" }; break;
456:     case "html":
457:       parseResult = {
458:         ok: false,
459:         error: `❌ <b>HTML-страница или заглушка!</b>\n\nОбнаружены фейковые ключи (0.0.0.0).\n\n💡 Открой в браузере → нажми "Добавить подписку" → скопируй ссылку`
460:       };
461:       break;
462:     default:
463:       parseResult = {
464:         ok: false,
465:         error: `❓ Неизвестный формат\n\nContent-Type: ${result.contentType}\nДлина: ${result.content.length}\n\nПервые 300 символов:\n${escapeHtml(result.content.substring(0, 300))}`
466:       };
467:   }
468: 
469:   parseResult.attempts = result.attempts;
470:   return parseResult;
471: }
