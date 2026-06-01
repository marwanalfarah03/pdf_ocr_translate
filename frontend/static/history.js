const historyBody = document.getElementById("historyBody");
const historyEmpty = document.getElementById("historyEmpty");
const refreshHistory = document.getElementById("refreshHistory");


function escapeHtml(value) {
    return String(value || "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}


function formatTimestamp(value) {
    const timestamp = Number(value || 0);
    if (!Number.isFinite(timestamp) || timestamp <= 0) {
        return "-";
    }
    return new Date(timestamp * 1000).toLocaleString();
}


function modeLabel(mode) {
    if (mode === "transcribe") {
        return "Transcribe";
    }
    if (mode === "transcribe_translate") {
        return "Transcribe + Translate";
    }
    if (mode === "translate_only") {
        return "Translate Only";
    }
    return mode || "-";
}


function renderDownloads(urlMap) {
    if (!urlMap || typeof urlMap !== "object") {
        return "-";
    }

    const labels = {
        txt: "TXT ZIP",
        docx: "DOCX",
        translated_docx: "Translated DOCX",
    };

    const links = [];
    for (const key of Object.keys(labels)) {
        const url = urlMap[key];
        if (!url) {
            continue;
        }
        links.push(`<a class="download-chip" href="${escapeHtml(url)}">${labels[key]}</a>`);
    }
    return links.length > 0 ? links.join("") : "-";
}


function renderItems(items) {
    historyBody.innerHTML = "";
    if (!items || items.length === 0) {
        historyEmpty.hidden = false;
        return;
    }

    historyEmpty.hidden = true;

    const rows = items.map((item) => {
        const statusClass = item.status === "failed" ? "status-failed" : (item.status === "completed" ? "status-completed" : "");
        return `
            <tr>
                <td>${escapeHtml(item.job_id)}</td>
                <td>${escapeHtml(item.filename)}</td>
                <td>${escapeHtml(modeLabel(item.mode))}</td>
                <td class="${statusClass}">${escapeHtml(item.status || "-")}</td>
                <td>${escapeHtml(formatTimestamp(item.created_at))}</td>
                <td>${escapeHtml(formatTimestamp(item.completed_at))}</td>
                <td>${renderDownloads(item.download_urls)}</td>
                <td>${escapeHtml(item.error || "-")}</td>
            </tr>
        `;
    }).join("");

    historyBody.innerHTML = rows;
}


async function loadHistory() {
    refreshHistory.disabled = true;
    try {
        const response = await fetch("/api/history");
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.error || "Could not load history.");
        }
        renderItems(Array.isArray(payload.items) ? payload.items : []);
    } catch (error) {
        renderItems([]);
        historyEmpty.hidden = false;
        historyEmpty.textContent = error.message;
    } finally {
        refreshHistory.disabled = false;
    }
}


refreshHistory.addEventListener("click", loadHistory);
loadHistory();
