(function () {
  const params = new URLSearchParams(window.location.search);
  const jobId = params.get("jobid") || "";
  const stageOrder = ["queued", "scanning", "analyzing", "matching", "finalizing", "completed"];
  const titleEl = document.getElementById("title");
  const subtitleEl = document.getElementById("subtitle");
  const statusEl = document.getElementById("statusMessage");
  const progressFillEl = document.getElementById("progressFill");
  const progressPctEl = document.getElementById("progressPct");
  const stageTextEl = document.getElementById("stageText");
  const openLinkEl = document.getElementById("openLink");
  const retryBtnEl = document.getElementById("retryBtn");
  const activityListEl = document.getElementById("activityList");
  let pollTimer = null;
  let redirected = false;
  let displayProgress = 0;
  let serverProgress = 0;
  let currentStage = "queued";
  let lastActivityKey = "";
  let animationFrame = null;
  let consecutiveErrors = 0;
  const startedAtMs = Date.now();
  const pollRequestTimeoutMs = 2500;
  const stageMax = {
    queued: 12,
    scanning: 34,
    analyzing: 62,
    matching: 84,
    finalizing: 96,
    completed: 100
  };

  if (!jobId) {
    setError("Missing job id in URL.");
    return;
  }

  retryBtnEl.addEventListener("click", () => {
    retryBtnEl.classList.add("hidden");
    pollStatus(true);
  });

  pollStatus(true);
  startSmoothProgress();

  async function pollStatus(immediate) {
    if (pollTimer) clearTimeout(pollTimer);
    if (!immediate) await wait(650);

    try {
      const response = await fetchWithTimeout(
        `/ditto/status?jobid=${encodeURIComponent(jobId)}&t=${Date.now()}`,
        pollRequestTimeoutMs
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Could not load job status.");
      }
      consecutiveErrors = 0;
      renderStatus(data);

      if (data.status === "completed") {
        openLinkEl.href = data.final_url;
        openLinkEl.classList.remove("hidden");
        if (!redirected && data.final_url) runCompletionAnimation(data.final_url);
        return;
      }

      if (data.status === "failed") {
        setError(data.error || "The job failed.");
        return;
      }

      pollTimer = setTimeout(() => pollStatus(true), 800);
    } catch (error) {
      const message = String(error?.message || "");
      const isTimeout = message.toLowerCase().includes("timed out");
      if (isTimeout) {
        renderInferredStatus();
        pollTimer = setTimeout(() => pollStatus(true), 700);
        return;
      }
      consecutiveErrors += 1;
      if (consecutiveErrors >= 4) {
        setError(message || "Network error while checking status.");
        return;
      }
      renderInferredStatus();
      pollTimer = setTimeout(() => pollStatus(true), 900);
    }
  }

  function renderStatus(data) {
    serverProgress = Math.max(0, Math.min(100, Number(data.progress) || 0));
    currentStage = data.stage || "queued";
    stageTextEl.textContent = currentStage;
    statusEl.textContent = data.message || "Processing...";
    subtitleEl.textContent = stageSubtitle(currentStage);
    setStageActive(currentStage);
    pushActivity(currentStage, data.message || stageSubtitle(currentStage));
    titleEl.textContent = data.status === "completed" ? "Done! Final URL generated" : "Preparing your reference capture";
  }

  function setStageActive(stage) {
    const stageIndex = Math.max(0, stageOrder.indexOf(stage));
    document.querySelectorAll(".stage-card").forEach((el) => {
      const cardStage = el.getAttribute("data-stage") || "";
      const idx = stageOrder.indexOf(cardStage);
      if (idx < stageIndex) {
        el.classList.add("done");
        el.classList.remove("active");
      } else if (idx === stageIndex) {
        el.classList.remove("done");
        el.classList.add("active");
      } else {
        el.classList.remove("done");
        el.classList.remove("active");
      }
    });
  }

  function stageSubtitle(stage) {
    if (stage === "queued") return "Request accepted and queued.";
    if (stage === "scanning") return "Scanning website structure and assets.";
    if (stage === "analyzing") return "Analyzing sections with AI.";
    if (stage === "matching") return "Matching best modules in order.";
    if (stage === "finalizing") return "Generating final Ditto URL.";
    if (stage === "completed") return "Redirecting to Reference Capture result.";
    return "Processing your request...";
  }

  function setError(message) {
    document.body.classList.add("error");
    statusEl.textContent = message;
    subtitleEl.textContent = "Unable to continue this job.";
    pushActivity("failed", message);
    retryBtnEl.classList.remove("hidden");
  }

  function startSmoothProgress() {
    const tick = () => {
      const cap = stageMax[currentStage] ?? 90;
      if (displayProgress < serverProgress) {
        displayProgress = Math.min(serverProgress, displayProgress + 2.2);
      } else {
        const target = Math.max(serverProgress, cap - 1);
        if (displayProgress < target) {
          displayProgress = Math.min(target, displayProgress + 0.28);
        }
      }
      const rounded = Math.max(0, Math.min(100, Math.round(displayProgress)));
      progressFillEl.style.width = `${rounded}%`;
      progressPctEl.textContent = `${rounded}%`;
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
  }

  function runCompletionAnimation(finalUrl) {
    redirected = true;
    document.body.classList.add("completed");
    const sequence = ["analyzing", "matching", "finalizing", "completed"];
    let step = 0;
    const run = () => {
      const stage = sequence[step] || "completed";
      currentStage = stage;
      serverProgress = stageMax[stage] || 100;
      setStageActive(stage);
      subtitleEl.textContent = stageSubtitle(stage);
      statusEl.textContent =
        stage === "completed"
          ? "Scan complete. Taking you to Reference Capture result..."
          : `Final checks: ${stage}...`;
      pushActivity(stage, statusEl.textContent);
      step += 1;
      if (step < sequence.length) {
        setTimeout(run, 420);
      } else {
        setTimeout(() => {
          window.location.href = finalUrl;
        }, 1100);
      }
    };
    run();
  }

  function renderInferredStatus() {
    if (redirected) return;
    const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000));
    let stage = "queued";
    let message = "Waiting for server updates...";
    if (elapsedSec >= 3 && elapsedSec < 12) {
      stage = "scanning";
      message = "Capturing website layout...";
    } else if (elapsedSec >= 12 && elapsedSec < 24) {
      stage = "analyzing";
      message = "Analyzing sections with AI...";
    } else if (elapsedSec >= 24 && elapsedSec < 36) {
      stage = "matching";
      message = "Matching modules against catalog...";
    } else if (elapsedSec >= 36) {
      stage = "finalizing";
      message = "Finalizing and preparing redirect...";
    }
    currentStage = stage;
    const cap = stageMax[stage] ?? 90;
    serverProgress = Math.max(serverProgress, Math.max(10, cap - 3));
    stageTextEl.textContent = stage;
    subtitleEl.textContent = stageSubtitle(stage);
    statusEl.textContent = message;
    setStageActive(stage);
    pushActivity(stage, message);
  }

  function pushActivity(stage, message) {
    const key = `${stage}:${message}`;
    if (!activityListEl || key === lastActivityKey) return;
    lastActivityKey = key;
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const li = document.createElement("li");
    li.textContent = `[${time}] ${message}`;
    activityListEl.prepend(li);
    const items = activityListEl.querySelectorAll("li");
    for (let i = 8; i < items.length; i += 1) {
      items[i].remove();
    }
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchWithTimeout(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        signal: controller.signal,
        cache: "no-store"
      });
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error("Status request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
})();
