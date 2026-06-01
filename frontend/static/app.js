const MODE_TRANSCRIBE = "transcribe";
const MODE_TRANSCRIBE_TRANSLATE = "transcribe_translate";
const MODE_TRANSLATE_ONLY = "translate_only";

const state = {
    mode: MODE_TRANSCRIBE,
    thinkingEnabled: true,
    uploadId: null,
    pages: [],
    jobId: null,
    eventSource: null,
    streamBlocks: new Map(),
};

const uploadForm = document.getElementById("uploadForm");
const modeSelect = document.getElementById("modeSelect");
const thinkingPicker = document.getElementById("thinkingPicker");
const thinkingEnabled = document.getElementById("thinkingEnabled");
const thinkingState = document.getElementById("thinkingState");
const fileInputLabel = document.getElementById("fileInputLabel");
const documentInput = document.getElementById("documentInput");
const uploadButton = document.getElementById("uploadButton");
const uploadStatus = document.getElementById("uploadStatus");
const selectionPanel = document.getElementById("selectionPanel");
const selectionSummary = document.getElementById("selectionSummary");
const pageGrid = document.getElementById("pageGrid");
const selectAllButton = document.getElementById("selectAllButton");
const clearAllButton = document.getElementById("clearAllButton");
const startButton = document.getElementById("startButton");
const livePanel = document.getElementById("livePanel");
const jobState = document.getElementById("jobState");
const streamStatus = document.getElementById("streamStatus");
const streamedPages = document.getElementById("streamedPages");
const downloadPanel = document.getElementById("downloadPanel");
const downloadTxt = document.getElementById("downloadTxt");
const downloadDocx = document.getElementById("downloadDocx");
const downloadTranslatedDocx = document.getElementById("downloadTranslatedDocx");
const pageCardTemplate = document.getElementById("pageCardTemplate");
const streamBlockTemplate = document.getElementById("streamBlockTemplate");


function setUploadStatus(message, isError = false) {
    uploadStatus.textContent = message;
    uploadStatus.style.color = isError ? "var(--danger)" : "";
}


function setStreamStatus(message, stateName = "info") {
    streamStatus.textContent = message;
    streamStatus.dataset.state = stateName;
}


function modeNeedsPageSelection(mode) {
    return mode === MODE_TRANSCRIBE || mode === MODE_TRANSCRIBE_TRANSLATE;
}


function syncThinkingUI() {
    state.thinkingEnabled = thinkingEnabled.checked;
    thinkingState.textContent = state.thinkingEnabled ? "Enabled" : "Disabled";
}


function applyModeUI() {
    state.mode = modeSelect.value;
    const modeUsesTranscription = modeNeedsPageSelection(state.mode);
    thinkingPicker.hidden = !modeUsesTranscription;
    thinkingEnabled.disabled = !modeUsesTranscription;
    syncThinkingUI();
    if (state.mode === MODE_TRANSLATE_ONLY) {
        fileInputLabel.textContent = "Select DOCX";
        documentInput.accept = ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        setUploadStatus("Choose a DOCX to start translation.");
    } else {
        fileInputLabel.textContent = "Select PDF";
        documentInput.accept = "application/pdf";
        setUploadStatus("Choose a PDF to start.");
    }
    documentInput.value = "";
    selectionPanel.hidden = true;
    startButton.disabled = true;
}


function configureDownloadLinks(downloadUrls) {
    downloadTxt.style.display = "none";
    downloadDocx.style.display = "none";
    downloadTranslatedDocx.style.display = "none";

    if (!downloadUrls) {
        return;
    }

    if (downloadUrls.txt) {
        downloadTxt.href = downloadUrls.txt;
        downloadTxt.style.display = "inline-flex";
    }
    if (downloadUrls.docx) {
        downloadDocx.href = downloadUrls.docx;
        downloadDocx.style.display = "inline-flex";
    }
    if (downloadUrls.translated_docx) {
        downloadTranslatedDocx.href = downloadUrls.translated_docx;
        downloadTranslatedDocx.style.display = "inline-flex";
    }
}


function resetStreamingState() {
    state.streamBlocks.clear();
    state.jobId = null;
    if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
    }
    streamedPages.innerHTML = "";
    jobState.textContent = "Waiting";
    downloadPanel.hidden = true;
    configureDownloadLinks(null);
}


function updateSelectionSummary() {
    const checked = pageGrid.querySelectorAll(".page-checkbox:checked").length;
    const total = state.pages.length;
    selectionSummary.textContent = `${checked} of ${total} page(s) selected.`;
    startButton.disabled = checked === 0;
}


function markPageCard(pageNumber, statusText, className) {
    const card = pageGrid.querySelector(`[data-page-number="${pageNumber}"]`);
    if (!card) {
        return;
    }
    card.classList.remove("is-running", "is-complete");
    if (className) {
        card.classList.add(className);
    }
    const status = card.querySelector(".page-card-status");
    if (status) {
        status.textContent = statusText;
    }
}


function makeLine() {
    const p = document.createElement("p");
    p.dir = "auto";
    return p;
}


function renderLines(outputEl, text) {
    outputEl.innerHTML = "";
    const lines = String(text || "").split("\n");
    const fragment = document.createDocumentFragment();
    for (const line of lines) {
        const p = makeLine();
        p.textContent = line;
        fragment.appendChild(p);
    }
    outputEl.appendChild(fragment);
}


function createStreamBlock(pageNumber, previewUrl) {
    if (state.streamBlocks.has(pageNumber)) {
        const refs = state.streamBlocks.get(pageNumber);
        if (previewUrl && !refs.preview.src) {
            refs.preview.src = previewUrl;
        }
        return refs;
    }

    const fragment = streamBlockTemplate.content.cloneNode(true);
    const block = fragment.querySelector(".stream-block");
    const title = fragment.querySelector("h3");
    const pill = fragment.querySelector(".pill");
    const output = fragment.querySelector(".stream-output");
    const preview = fragment.querySelector(".stream-preview");

    title.textContent = `Page ${pageNumber}`;
    pill.textContent = "Streaming";
    preview.alt = `Preview for page ${pageNumber}`;
    preview.src = previewUrl || "";

    const firstLine = makeLine();
    output.appendChild(firstLine);

    block.dataset.pageNumber = String(pageNumber);
    streamedPages.appendChild(fragment);

    const mountedBlock = streamedPages.querySelector(`.stream-block[data-page-number="${pageNumber}"]`);
    const mountedOutput = mountedBlock.querySelector(".stream-output");
    const mountedPill = mountedBlock.querySelector(".pill");
    const mountedPreview = mountedBlock.querySelector(".stream-preview");
    const mountedThinkingEl = mountedBlock.querySelector(".think-output");
    const mountedCurrentLine = mountedOutput.querySelector("p");

    const refs = {
        block: mountedBlock,
        output: mountedOutput,
        pill: mountedPill,
        preview: mountedPreview,
        currentLine: mountedCurrentLine,
        thinkingEl: mountedThinkingEl,
        thinkCurrentLine: null,
    };
    state.streamBlocks.set(pageNumber, refs);
    return refs;
}


function renderPageGrid(pages) {
    pageGrid.innerHTML = "";
    const fragment = document.createDocumentFragment();

    pages.forEach((page) => {
        const cardFragment = pageCardTemplate.content.cloneNode(true);
        const card = cardFragment.querySelector(".page-card");
        const checkbox = cardFragment.querySelector(".page-checkbox");
        const image = cardFragment.querySelector(".page-card-image");
        const title = cardFragment.querySelector(".page-card-title");

        card.dataset.pageNumber = String(page.page_number);
        checkbox.value = String(page.page_number);
        checkbox.checked = true;
        image.src = page.preview_url;
        image.alt = `Preview of page ${page.page_number}`;
        title.textContent = `Page ${page.page_number}`;
        checkbox.addEventListener("change", updateSelectionSummary);
        fragment.appendChild(cardFragment);
    });

    pageGrid.appendChild(fragment);
    updateSelectionSummary();
}


function selectedPages() {
    return [...pageGrid.querySelectorAll(".page-checkbox:checked")]
        .map((checkbox) => Number.parseInt(checkbox.value, 10))
        .filter((value) => Number.isInteger(value))
        .sort((left, right) => left - right);
}


async function uploadDocument(event) {
    event.preventDefault();
    const file = documentInput.files[0];
    if (!file) {
        setUploadStatus(state.mode === MODE_TRANSLATE_ONLY ? "Choose a DOCX first." : "Choose a PDF first.", true);
        return;
    }

    resetStreamingState();
    uploadButton.disabled = true;
    startButton.disabled = true;
    setUploadStatus(`Uploading ${file.name} ...`);

    const formData = new FormData();
    formData.append("mode", state.mode);
    formData.append("document", file);

    try {
        const response = await fetch("/api/upload", {
            method: "POST",
            body: formData,
        });
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.error || "Upload failed.");
        }

        state.uploadId = payload.upload_id;
        state.pages = payload.pages || [];
        state.mode = payload.mode || state.mode;

        livePanel.hidden = false;

        if (modeNeedsPageSelection(state.mode)) {
            renderPageGrid(state.pages);
            selectionPanel.hidden = false;
            setUploadStatus(`${payload.filename} uploaded. Choose pages and start processing.`);
            setStreamStatus("Ready to start. Select the pages you want to process.");
        } else {
            selectionPanel.hidden = true;
            setUploadStatus(`${payload.filename} uploaded. Starting translation ...`);
            setStreamStatus("Creating translation job ...");
            await startProcessing();
        }
    } catch (error) {
        setUploadStatus(error.message, true);
    } finally {
        uploadButton.disabled = false;
    }
}


function openStream(jobId) {
    if (state.eventSource) {
        state.eventSource.close();
    }

    const source = new EventSource(`/api/jobs/${jobId}/stream`);
    state.eventSource = source;

    source.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        handleJobEvent(payload);
    };

    source.onerror = () => {
        if (jobState.textContent !== "Completed" && jobState.textContent !== "Failed") {
            setStreamStatus("The live stream disconnected. The job may still be running.", "error");
        }
    };
}


function handleJobEvent(event) {
    if (event.type === "status") {
        if (event.status === "queued") {
            jobState.textContent = "Queued";
            setStreamStatus("Job queued.");
        }
        if (event.status === "running") {
            jobState.textContent = "Running";
            if (state.mode === MODE_TRANSLATE_ONLY) {
                setStreamStatus("Translation is running.");
            } else {
                setStreamStatus("OCR is running for selected pages.");
            }
        }
        if (event.status === "completed") {
            jobState.textContent = "Completed";
            setStreamStatus("Processing complete. Downloads are ready.");
            configureDownloadLinks(event.download_urls || {});
            downloadPanel.hidden = false;
            startButton.disabled = false;
            if (state.eventSource) {
                state.eventSource.close();
                state.eventSource = null;
            }
        }
        if (event.status === "failed") {
            jobState.textContent = "Failed";
            setStreamStatus(event.error || "The job failed.", "error");
            startButton.disabled = false;
            if (state.eventSource) {
                state.eventSource.close();
                state.eventSource = null;
            }
        }
        return;
    }

    if (event.type === "page_start") {
        const refs = createStreamBlock(event.page_number, event.preview_url);
        refs.pill.textContent = "Streaming";
        markPageCard(event.page_number, "Streaming", "is-running");
        return;
    }

    if (event.type === "think_token") {
        const refs = createStreamBlock(event.page_number, "");
        if (!refs.thinkCurrentLine) {
            refs.thinkingEl.hidden = false;
            const firstThinkLine = makeLine();
            refs.thinkingEl.appendChild(firstThinkLine);
            refs.thinkCurrentLine = firstThinkLine;
        }
        const parts = String(event.token || "").split("\n");
        refs.thinkCurrentLine.textContent += parts[0];
        for (let i = 1; i < parts.length; i++) {
            const p = makeLine();
            p.textContent = parts[i];
            refs.thinkingEl.appendChild(p);
            refs.thinkCurrentLine = p;
        }
        refs.thinkingEl.scrollTop = refs.thinkingEl.scrollHeight;
        return;
    }

    if (event.type === "think_done") {
        const refs = state.streamBlocks.get(event.page_number);
        if (refs) {
            refs.thinkingEl.hidden = true;
            refs.thinkingEl.innerHTML = "";
            refs.thinkCurrentLine = null;
        }
        return;
    }

    if (event.type === "token") {
        const refs = createStreamBlock(event.page_number, "");
        const parts = String(event.token || "").split("\n");
        refs.currentLine.textContent += parts[0];
        for (let i = 1; i < parts.length; i++) {
            const p = makeLine();
            p.textContent = parts[i];
            refs.output.appendChild(p);
            refs.currentLine = p;
        }
        refs.output.scrollTop = refs.output.scrollHeight;
        return;
    }

    if (event.type === "page_complete") {
        const refs = createStreamBlock(event.page_number, event.preview_url);
        refs.thinkingEl.hidden = true;
        refs.thinkingEl.innerHTML = "";
        refs.thinkCurrentLine = null;
        renderLines(refs.output, event.text);
        refs.currentLine = refs.output.lastElementChild;
        refs.pill.textContent = "Complete";
        markPageCard(event.page_number, "Complete", "is-complete");
        return;
    }

    if (event.type === "translation_start") {
        setStreamStatus("Translation step started.");
        return;
    }

    if (event.type === "translation_progress") {
        const totalBatches = Number(event.total_batches || 0);
        const processedBatches = Number(event.processed_batches || 0);
        const totalLines = Number(event.total_lines || 0);
        const processedLines = Number(event.processed_lines || 0);
        const batchText = totalBatches > 0 ? `batch ${processedBatches}/${totalBatches}` : "batching";
        const lineText = totalLines > 0 ? `, lines ${processedLines}/${totalLines}` : "";
        setStreamStatus(`Translation in progress: ${batchText}${lineText}.`);
        return;
    }

    if (event.type === "translation_complete") {
        setStreamStatus("Translation complete.");
    }
}


async function startProcessing() {
    if (!state.uploadId) {
        setStreamStatus("Upload a file first.", "error");
        return;
    }

    const pages = modeNeedsPageSelection(state.mode) ? selectedPages() : [];
    if (modeNeedsPageSelection(state.mode) && pages.length === 0) {
        setStreamStatus("Select at least one page before starting.", "error");
        return;
    }

    resetStreamingState();
    livePanel.hidden = false;
    startButton.disabled = true;
    setStreamStatus("Creating job ...");

    [...pageGrid.querySelectorAll(".page-card")].forEach((card) => card.classList.remove("is-running", "is-complete"));
    [...pageGrid.querySelectorAll(".page-card-status")].forEach((status) => {
        status.textContent = "Queued";
    });

    try {
        const response = await fetch("/api/jobs", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                upload_id: state.uploadId,
                selected_pages: pages,
                thinking_enabled: modeNeedsPageSelection(state.mode) ? state.thinkingEnabled : true,
            }),
        });
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.error || "Could not start the job.");
        }

        state.jobId = payload.job_id;
        openStream(payload.job_id);
    } catch (error) {
        startButton.disabled = false;
        setStreamStatus(error.message, "error");
    }
}


uploadForm.addEventListener("submit", uploadDocument);
modeSelect.addEventListener("change", applyModeUI);
thinkingEnabled.addEventListener("change", syncThinkingUI);

selectAllButton.addEventListener("click", () => {
    pageGrid.querySelectorAll(".page-checkbox").forEach((checkbox) => {
        checkbox.checked = true;
    });
    updateSelectionSummary();
});

clearAllButton.addEventListener("click", () => {
    pageGrid.querySelectorAll(".page-checkbox").forEach((checkbox) => {
        checkbox.checked = false;
    });
    updateSelectionSummary();
});

startButton.addEventListener("click", startProcessing);

applyModeUI();
