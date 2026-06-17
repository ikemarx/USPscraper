// Chrome MV3: importScripts torna JSZip disponível globalmente no service worker.
// Firefox MV3: jszip.min.js é listado antes de background.js em manifest.json "scripts".
if (typeof importScripts !== "undefined") importScripts("vendor/jszip.min.js");

// Shim: Firefox expõe browser.* (Promise-based), Chrome expõe chrome.* (callbacks).
const api = (() => {
  if (typeof browser !== "undefined") return browser;
  const wrap = (fn) => (...args) => new Promise((resolve, reject) => {
    fn(...args, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
  return {
    cookies: { get: wrap(chrome.cookies.get.bind(chrome.cookies)) },
    downloads: { download: wrap(chrome.downloads.download.bind(chrome.downloads)) },
    runtime: chrome.runtime,
  };
})();

const BASE_URL = "https://edisciplinas.usp.br";

async function getSessionCookie() {
  const cookie = await api.cookies.get({ url: BASE_URL, name: "MoodleSessionedisciplinas" });
  return cookie?.value ?? null;
}

async function getSesskey() {
  const res = await fetch(`${BASE_URL}/my/`, { credentials: "include" });
  const html = await res.text();
  const match = html.match(/"sesskey"\s*:\s*"([^"]+)"/);
  return match?.[1] ?? null;
}

async function getEnrolledCourses(sesskey, classification = "inprogress") {
  const url = `${BASE_URL}/lib/ajax/service.php?sesskey=${sesskey}&info=core_course_get_enrolled_courses_by_timeline_classification`;
  const payload = [{
    index: 0,
    methodname: "core_course_get_enrolled_courses_by_timeline_classification",
    args: { offset: 0, limit: 0, classification, sort: "fullname", customfieldname: "", customfieldvalue: "" },
  }];
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    credentials: "include",
  });
  const data = await res.json();
  if (!data?.[0] || data[0].error) throw new Error(data?.[0]?.exception?.message ?? "Erro na API do Moodle");
  return data[0].data.courses.map(c => ({ id: String(c.id), name: c.fullname }));
}

async function resolveExternalUrl(moodleUrl) {
  try {
    const res = await fetch(moodleUrl, { credentials: "include", redirect: "follow" });
    if (!res.url.includes("edisciplinas.usp.br")) return res.url;
    const html = await res.text();
    const match = html.match(/href="(https?:\/\/(?!edisciplinas\.usp\.br)[^"]+)"/);
    return match?.[1] ?? moodleUrl;
  } catch {
    return moodleUrl;
  }
}

function safeName(str) {
  return str.replace(/[/\\:*?"<>|]/g, "-").trim();
}

function linkLabel(anchor) {
  const clone = anchor.cloneNode(true);
  clone.querySelectorAll(".accesshide").forEach(el => el.remove());
  return safeName(clone.textContent.trim()) || "arquivo";
}

function notify(courseId, payload) {
  api.runtime.sendMessage({ ...payload, courseId }).catch(() => {});
}

function extractCourseCode(courseName) {
  const match = courseName.match(/\b([A-Z0-9]{3}\d{4})\b/i);
  return match?.[1]?.toUpperCase() ?? null;
}

async function fetchJupiterInfo(code) {
  try {
    const res = await fetch(
      `https://uspdigital.usp.br/jupiterweb/obterDisciplina?nomdis=&sgldis=${code}&print=true`
    );
    if (!res.ok) return null;

    // JupiterWeb usa windows-1252/ISO-8859-1; res.text() assumiria UTF-8 e quebraria os acentos
    const buffer = await res.arrayBuffer();
    let html = new TextDecoder("windows-1252").decode(buffer);

    // Atualiza o charset declarado para UTF-8, senão o browser re-quebra ao abrir o arquivo
    if (/<meta[^>]+charset/i.test(html)) {
      html = html.replace(/<meta[^>]+charset[^>]*>/i, '<meta charset="utf-8">');
    } else {
      html = html.replace(/<head>/i, '<head><meta charset="utf-8">');
    }

    // Resolve links relativos contra o domínio real
    html = html.replace(/<head>/i, '<head><base href="https://uspdigital.usp.br/">');

    return html;
  } catch {
    return null;
  }
}

// Faz fetch de um arquivo e retorna { filename, buffer }, ou null se falhar.
async function fetchFile(url, fallbackName) {
  try {
    const res = await fetch(url, { credentials: "include", redirect: "follow" });
    if (!res.ok) return null;

    let filename = fallbackName;
    const cd = res.headers.get("content-disposition");
    if (cd) {
      const utf8Match = cd.match(/filename\*=UTF-8''([^;\r\n]+)/i);
      const plainMatch = cd.match(/filename=["']?([^"';\r\n]+)["']?/i);
      const raw = utf8Match?.[1] ?? plainMatch?.[1];
      if (raw) filename = safeName(decodeURIComponent(raw.trim()));
    }

    const buffer = await res.arrayBuffer();
    return { filename, buffer };
  } catch {
    return null;
  }
}

async function downloadCourse(courseId, courseName) {
  const zipName = safeName(courseName);
  notify(courseId, { type: "status", message: "Carregando página do curso..." });

  const res = await fetch(`${BASE_URL}/course/view.php?id=${courseId}`, { credentials: "include" });
  const html = await res.text();

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  const links = [...doc.querySelectorAll(
    'a[href*="mod/resource/view.php"], a[href*="mod/folder/view.php"], a[href*="mod/url/view.php"]'
  )];
  notify(courseId, { type: "status", message: `${links.length} materiais encontrados — baixando...` });

  const zip = new JSZip();
  const filesFolder = zip.folder("files");
  const urlToLocal = {};

  for (const link of links) {
    const href = link.href;
    const label = linkLabel(link);

    if (href.includes("mod/resource")) {
      const file = await fetchFile(href, label);
      if (file) {
        filesFolder.file(file.filename, file.buffer);
        urlToLocal[href] = `files/${file.filename}`;
        notify(courseId, { type: "file", name: file.filename });
      }

    } else if (href.includes("mod/folder")) {
      const folderId = href.match(/id=(\d+)/)?.[1];
      if (folderId) {
        const dlUrl = `${BASE_URL}/mod/folder/download_folder.php?id=${folderId}`;
        const file = await fetchFile(dlUrl, `Pasta_${label}.zip`);
        if (file) {
          filesFolder.file(file.filename, file.buffer);
          urlToLocal[href] = `files/${file.filename}`;
          notify(courseId, { type: "file", name: file.filename });
        }
      }

    } else if (href.includes("mod/url")) {
      const external = await resolveExternalUrl(href);
      if (external !== href) urlToLocal[href] = external;
    }
  }

  // Reescreve links no HTML e adiciona index.html ao zip
  for (const a of doc.querySelectorAll("a[href]")) {
    const mapped = urlToLocal[a.href];
    if (mapped) {
      a.setAttribute("href", mapped);
      a.setAttribute("target", "_blank");
    }
  }
  zip.file("index.html", doc.documentElement.outerHTML);

  // Informações da disciplina no JupiterWeb
  const code = extractCourseCode(courseName);
  if (code) {
    const jupiterHtml = await fetchJupiterInfo(code);
    if (jupiterHtml) {
      zip.file("disciplina.html", jupiterHtml);
      notify(courseId, { type: "file", name: `disciplina.html (${code})` });
    }
  }

  notify(courseId, { type: "status", message: "Comprimindo..." });
  const zipBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
  const zipUrl = URL.createObjectURL(zipBlob);
  await api.downloads.download({ url: zipUrl, filename: `${zipName}.zip`, saveAs: false });

  notify(courseId, { type: "done" });
}

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_COURSES") {
    (async () => {
      try {
        const cookie = await getSessionCookie();
        if (!cookie) {
          sendResponse({ error: "Cookie não encontrado. Faça login no edisciplinas primeiro." });
          return;
        }
        const sesskey = await getSesskey();
        if (!sesskey) {
          sendResponse({ error: "Não foi possível extrair o sesskey. Recarregue o edisciplinas." });
          return;
        }
        const courses = await getEnrolledCourses(sesskey, message.classification ?? "inprogress");
        sendResponse({ courses });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (message.type === "DOWNLOAD_COURSES") {
    const { courseIds, courses } = message;
    const selected = courses.filter(c => courseIds.includes(c.id));
    (async () => {
      for (const course of selected) {
        await downloadCourse(course.id, course.name);
      }
      sendResponse({ done: true });
    })();
    return true;
  }
});
