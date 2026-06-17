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

    // JupiterWeb usa windows-1252; res.text() quebraria os acentos
    const buffer = await res.arrayBuffer();
    let html = new TextDecoder("windows-1252").decode(buffer);

    if (/<meta[^>]+charset/i.test(html)) {
      html = html.replace(/<meta[^>]+charset[^>]*>/i, '<meta charset="utf-8">');
    } else {
      html = html.replace(/<head>/i, '<head><meta charset="utf-8">');
    }
    html = html.replace(/<head>/i, '<head><base href="https://uspdigital.usp.br/">');

    return html;
  } catch {
    return null;
  }
}

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

// data: URLs funcionam tanto em service workers (Chrome) quanto em background pages (Firefox)
function bufferToDataUrl(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return `data:application/octet-stream;base64,${btoa(binary)}`;
}

function htmlToDataUrl(html) {
  return `data:text/html;base64,${btoa(unescape(encodeURIComponent(html)))}`;
}

async function downloadCourse(courseId, courseName) {
  const folderName = safeName(courseName);
  notify(courseId, { type: "status", message: "Carregando página do curso..." });

  const res = await fetch(`${BASE_URL}/course/view.php?id=${courseId}`, { credentials: "include" });
  const html = await res.text();

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  const links = [...doc.querySelectorAll(
    'a[href*="mod/resource/view.php"], a[href*="mod/folder/view.php"], a[href*="mod/url/view.php"]'
  )];
  notify(courseId, { type: "status", message: `${links.length} materiais encontrados — baixando...` });

  const urlToLocal = {};

  for (const link of links) {
    const href = link.href;
    const label = linkLabel(link);

    if (href.includes("mod/resource")) {
      const file = await fetchFile(href, label);
      if (file) {
        await api.downloads.download({
          url: bufferToDataUrl(file.buffer),
          filename: `${folderName}/files/${file.filename}`,
          saveAs: false,
        });
        urlToLocal[href] = `files/${file.filename}`;
        notify(courseId, { type: "file", name: file.filename });
      }

    } else if (href.includes("mod/folder")) {
      const folderId = href.match(/id=(\d+)/)?.[1];
      if (folderId) {
        const dlUrl = `${BASE_URL}/mod/folder/download_folder.php?id=${folderId}`;
        const file = await fetchFile(dlUrl, `Pasta_${label}.zip`);
        if (file) {
          await api.downloads.download({
            url: bufferToDataUrl(file.buffer),
            filename: `${folderName}/files/${file.filename}`,
            saveAs: false,
          });
          urlToLocal[href] = `files/${file.filename}`;
          notify(courseId, { type: "file", name: file.filename });
        }
      }

    } else if (href.includes("mod/url")) {
      const external = await resolveExternalUrl(href);
      if (external !== href) urlToLocal[href] = external;
    }
  }

  // Reescreve links no HTML e salva index.html
  for (const a of doc.querySelectorAll("a[href]")) {
    const mapped = urlToLocal[a.href];
    if (mapped) {
      a.setAttribute("href", mapped);
      a.setAttribute("target", "_blank");
    }
  }
  await api.downloads.download({
    url: htmlToDataUrl(doc.documentElement.outerHTML),
    filename: `${folderName}/index.html`,
    saveAs: false,
  });
  notify(courseId, { type: "file", name: "index.html" });

  // Informações da disciplina no JupiterWeb
  const code = extractCourseCode(courseName);
  if (code) {
    const jupiterHtml = await fetchJupiterInfo(code);
    if (jupiterHtml) {
      await api.downloads.download({
        url: htmlToDataUrl(jupiterHtml),
        filename: `${folderName}/disciplina.html`,
        saveAs: false,
      });
      notify(courseId, { type: "file", name: `disciplina.html (${code})` });
    }
  }

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
