const api = typeof browser !== "undefined" ? browser : chrome;

const $loading = document.getElementById("loading");
const $error = document.getElementById("error");
const $coursesSection = document.getElementById("courses-section");
const $courseList = document.getElementById("course-list");
const $btnDownload = document.getElementById("btn-download");
const $btnSelectAll = document.getElementById("btn-select-all");
const $log = document.getElementById("log");

let allCourses = [];

function showError(msg) {
  $error.textContent = msg;
  $error.style.display = "block";
  $loading.style.display = "none";
}

function addLog(msg, cls = "") {
  $log.style.display = "block";
  const line = document.createElement("div");
  line.className = `log-line ${cls}`;
  line.textContent = msg;
  $log.appendChild(line);
  $log.scrollTop = $log.scrollHeight;
}

function getSelected() {
  return [...$courseList.querySelectorAll("input:checked")].map(i => i.value);
}

function updateCourseStatus(courseId, text, cls) {
  const item = $courseList.querySelector(`[data-id="${courseId}"]`);
  if (!item) return;
  let span = item.querySelector(".status");
  if (!span) { span = document.createElement("span"); span.className = "status"; item.appendChild(span); }
  span.textContent = text;
  span.className = `status ${cls}`;
}

function renderCourses(courses) {
  $courseList.innerHTML = "";
  allSelected = false;
  $btnSelectAll.textContent = "Todos";
  $btnDownload.disabled = true;

  for (const course of courses) {
    const item = document.createElement("div");
    item.className = "course-item";
    item.dataset.id = course.id;
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = course.id;
    cb.id = `c-${course.id}`;
    const lbl = document.createElement("label");
    lbl.className = "course-name";
    lbl.htmlFor = `c-${course.id}`;
    lbl.textContent = course.name;
    item.appendChild(cb);
    item.appendChild(lbl);
    item.addEventListener("click", (e) => {
      if (e.target.tagName === "INPUT") return;
      const cb = item.querySelector("input");
      cb.checked = !cb.checked;
      item.classList.toggle("selected", cb.checked);
      $btnDownload.disabled = !getSelected().length;
    });
    item.querySelector("input").addEventListener("change", (e) => {
      item.classList.toggle("selected", e.target.checked);
      $btnDownload.disabled = !getSelected().length;
    });
    $courseList.appendChild(item);
  }
}

function loadCourses(classification) {
  $error.style.display = "none";
  $coursesSection.style.display = "none";
  $loading.style.display = "block";

  api.runtime.sendMessage({ type: "GET_COURSES", classification }, (response) => {
    $loading.style.display = "none";
    if (!response || response.error) { showError(response?.error ?? "Erro desconhecido."); return; }

    allCourses = response.courses;
    const emptyMsg = classification === "inprogress"
      ? "Nenhum curso em andamento encontrado."
      : "Nenhum curso encontrado.";
    if (!allCourses.length) { showError(emptyMsg); return; }

    renderCourses(allCourses);
    $coursesSection.style.display = "block";
  });
}

// Toggle ativas / todas
const $toggleBtns = document.querySelectorAll(".toggle-pill button");
$toggleBtns.forEach(btn => {
  btn.addEventListener("click", () => {
    if (btn.classList.contains("active")) return;
    $toggleBtns.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    loadCourses(btn.dataset.filter);
  });
});

// Carrega cursos ao abrir o popup
loadCourses("inprogress");

// Selecionar todos
let allSelected = false;
$btnSelectAll.addEventListener("click", () => {
  allSelected = !allSelected;
  $courseList.querySelectorAll("input").forEach(cb => {
    cb.checked = allSelected;
    cb.closest(".course-item").classList.toggle("selected", allSelected);
  });
  $btnSelectAll.textContent = allSelected ? "Nenhum" : "Todos";
  $btnDownload.disabled = !getSelected().length;
});

// Iniciar download
$btnDownload.addEventListener("click", () => {
  const selected = getSelected();
  if (!selected.length) return;

  $btnDownload.disabled = true;
  $btnSelectAll.disabled = true;
  $courseList.querySelectorAll("input").forEach(i => i.disabled = true);

  for (const id of selected) updateCourseStatus(id, "aguardando...", "");

  api.runtime.sendMessage({ type: "DOWNLOAD_COURSES", courseIds: selected, courses: allCourses }, () => {
    addLog("Todos os downloads foram iniciados.", "done");
    $btnDownload.disabled = false;
    $btnSelectAll.disabled = false;
  });
});

// Recebe atualizações de progresso do background
api.runtime.onMessage.addListener((message) => {
  if (!message.courseId) return;

  if (message.type === "status") {
    updateCourseStatus(message.courseId, message.message, "running");
  } else if (message.type === "file") {
    addLog(`↓ ${message.name}`);
  } else if (message.type === "done") {
    const name = allCourses.find(c => c.id === message.courseId)?.name ?? message.courseId;
    updateCourseStatus(message.courseId, "✓ concluído", "done");
    addLog(`✓ ${name}`, "done");
  } else if (message.type === "error") {
    updateCourseStatus(message.courseId, "erro", "error");
    addLog(`✗ Erro: ${message.message}`);
  }
});
