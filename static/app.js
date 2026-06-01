const state = {
    uploadId: null,
    pages: [],
    jobId: null,
    eventSource: null,
    streamBlocks: new Map(),
};

const uploadForm = document.getElementById("uploadForm");
const pdfInput = document.getElementById("pdfInput");
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
const currentPagePreview = document.getElementById("currentPagePreview");
const currentPageLabel = document.getElementById("currentPageLabel");
const streamedPages = document.getElementById("streamedPages");
const downloadPanel = document.getElementById("downloadPanel");
const downloadTxt = document.getElementById("downloadTxt");
const downloadDocx = document.getElementById("downloadDocx");
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


function resetStreamingState() {
    state.streamBlocks.clear();
    state.jobId = null;
    if (state.eventSource) {
        state.eventSource.close();
        state.eventSource = null;
    }
    streamedPages.innerHTML = "";
    currentPagePreview.hidden = true;
    currentPagePreview.removeAttribute("src");
    currentPageLabel.textContent = "No page is being processed yet.";
    jobState.textContent = "Waiting";
    downloadPanel.hidden = true;
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
    const lines = text.split("\n");
    const fragment = document.createDocumentFragment();
    for (const line of lines) {
        const p = makeLine();
        p.textContent = line;
        fragment.appendChild(p);
    }
    outputEl.appendChild(fragment);
}

function createStreamBlock(pageNumber) {
    if (state.streamBlocks.has(pageNumber)) {
        return state.streamBlocks.get(pageNumber);
    }
    const fragment = streamBlockTemplate.content.cloneNode(true);
    const block = fragment.querySelector(".stream-block");
    const title = fragment.querySelector("h3");
    const pill = fragment.querySelector(".pill");
    const output = fragment.querySelector(".stream-output");

    title.textContent = `Page ${pageNumber}`;
    pill.textContent = "Streaming";

    const firstLine = makeLine();
    output.appendChild(firstLine);

    block.dataset.pageNumber = String(pageNumber);
    streamedPages.appendChild(fragment);

    const mountedBlock = streamedPages.querySelector(`.stream-block[data-page-number="${pageNumber}"]`);
    const mountedOutput = mountedBlock.querySelector(".stream-output");
    const mountedPill = mountedBlock.querySelector(".pill");
    const mountedCurrentLine = mountedOutput.querySelector("p");

    const refs = { block: mountedBlock, output: mountedOutput, pill: mountedPill, currentLine: mountedCurrentLine };
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


async function uploadPdf(event) {
    event.preventDefault();
    const file = pdfInput.files[0];
    if (!file) {
        setUploadStatus("Choose a PDF first.", true);
        return;
    }

    resetStreamingState();
    uploadButton.disabled = true;
    startButton.disabled = true;
    setUploadStatus(`Uploading ${file.name} ...`);

    const formData = new FormData();
    formData.append("pdf", file);

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
        state.pages = payload.pages;

        renderPageGrid(payload.pages);
        selectionPanel.hidden = false;
        livePanel.hidden = false;
        setUploadStatus(`${payload.filename} uploaded. Choose pages and start the transcription.`);
        setStreamStatus("Ready to start. Select the pages you want to process.");
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
            setStreamStatus("The live stream disconnected. The transcription job may still be running.", "error");
        }
    };
}


function handleJobEvent(event) {
    if (event.type === "status") {
        if (event.status === "queued") {
            jobState.textContent = "Queued";
            setStreamStatus("Job queued. Waiting for the first page.");
        }
        if (event.status === "running") {
            jobState.textContent = "Running";
            setStreamStatus("Ollama is transcribing the selected pages.");
        }
        if (event.status === "completed") {
            jobState.textContent = "Completed";
            setStreamStatus("Transcription complete. Choose an export format.");
            downloadTxt.href = event.download_urls.txt;
            downloadDocx.href = event.download_urls.docx;
            downloadPanel.hidden = false;
            startButton.disabled = false;
            if (state.eventSource) {
                state.eventSource.close();
                state.eventSource = null;
            }
        }
        if (event.status === "failed") {
            jobState.textContent = "Failed";
            setStreamStatus(event.error || "The transcription job failed.", "error");
            startButton.disabled = false;
            if (state.eventSource) {
                state.eventSource.close();
                state.eventSource = null;
            }
        }
        return;
    }

    if (event.type === "page_start") {
        currentPagePreview.src = event.preview_url;
        currentPagePreview.hidden = false;
        currentPageLabel.textContent = `Streaming page ${event.page_number} (${event.selected_index} of ${event.total_selected}).`;
        markPageCard(event.page_number, "Streaming", "is-running");
        return;
    }

    if (event.type === "token") {
        const refs = createStreamBlock(event.page_number);
        const parts = event.token.split("\n");
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
        const refs = createStreamBlock(event.page_number);
        renderLines(refs.output, event.text);
        refs.currentLine = refs.output.lastElementChild;
        refs.pill.textContent = "Complete";
        markPageCard(event.page_number, "Complete", "is-complete");
    }
}


async function startTranscription() {
    const pages = selectedPages();
    if (!state.uploadId || pages.length === 0) {
        setStreamStatus("Select at least one page before starting.", "error");
        return;
    }

    resetStreamingState();
    livePanel.hidden = false;
    startButton.disabled = true;
    setStreamStatus("Creating the transcription job ...");
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
            }),
        });
        const payload = await response.json();
        if (!response.ok) {
            throw new Error(payload.error || "Could not start the transcription job.");
        }

        state.jobId = payload.job_id;
        openStream(payload.job_id);
    } catch (error) {
        startButton.disabled = false;
        setStreamStatus(error.message, "error");
    }
}


uploadForm.addEventListener("submit", uploadPdf);

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

startButton.addEventListener("click", startTranscription);
