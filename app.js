const $ = id => document.getElementById(id);

let peer;
let connection = null;
let selectedFiles = [];
let currentTransfer = null;
let activeSender = null;
let scanner = null;
let historyItems = JSON.parse(localStorage.getItem("p2pHistory") || "[]");

const CHUNK_SIZE = 64 * 1024;

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1048576).toFixed(2) + " MB";
  return (bytes / 1073741824).toFixed(2) + " GB";
}

function setStatus(message) {
  $("statusText").textContent = message;
}

function addHistory(name, size, type) {
  historyItems.unshift({
    name,
    size: formatSize(size),
    type,
    date: new Date().toLocaleString()
  });

  historyItems = historyItems.slice(0, 50);
  localStorage.setItem("p2pHistory", JSON.stringify(historyItems));
  renderHistory();
}

function renderHistory() {
  if (!historyItems.length) {
    $("history").innerHTML = '<div class="empty-state"><div>📜</div><p>No transfer history yet.</p></div>';
    return;
  }

  $("history").innerHTML = historyItems.map(item => `
    <div class="history-item">
      <div>
        <strong>${escapeHTML(item.name)}</strong>
        <small>${escapeHTML(item.type)} • ${escapeHTML(item.size)} • ${escapeHTML(item.date)}</small>
      </div>
    </div>
  `).join("");
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}

function renderSelectedFiles() {
  if (!selectedFiles.length) {
    $("selectedFiles").textContent = "No files selected yet.";
    $("fileInfo").textContent = "No files selected";
    $("sendBtn").disabled = true;
    return;
  }

  $("fileInfo").textContent =
    `${selectedFiles.length} file(s) • ${formatSize(selectedFiles.reduce((sum, file) => sum + file.size, 0))}`;

  $("selectedFiles").innerHTML = selectedFiles.map((file, index) => `
    <div class="file-item">
      <div>
        <strong>${escapeHTML(file.name)}</strong>
        <small>${formatSize(file.size)}</small>
      </div>
      <button class="secondary-btn" data-remove="${index}">Remove</button>
    </div>
  `).join("");

  $("sendBtn").disabled = !connection || !connection.open;
}

function renderTransfer(message, percent = 0, speed = "") {
  $("transferList").innerHTML = `
    <div class="transfer-item">
      <div style="width:100%">
        <strong>${escapeHTML(message)}</strong>
        <progress value="${percent}" max="100"></progress>
        <small>${percent.toFixed(1)}% ${speed}</small>
        <div id="transferControls" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">
        </div>
      </div>
    </div>
  `;
  $("transferCount").textContent = "1 TRANSFER";
}

function clearTransfer() {
  $("transferList").innerHTML = `
    <div class="empty-state"><div>📡</div><p>No active transfers</p></div>
  `;
  $("transferCount").textContent = "0 TRANSFERS";
}

function updateConnectionUI(connected) {
  $("connectionStatus").textContent = connected
    ? "🟢 Device connected"
    : "No device connected";

  $("sendBtn").disabled = !connected || selectedFiles.length === 0;
}

function setupPeer() {
  if (!window.Peer) {
    setStatus("PeerJS library could not load. Refresh the page.");
    return;
  }

  peer = new Peer(undefined, {
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
      ]
    }
  });

  peer.on("open", id => {
    $("myId").textContent = id;
    $("networkStatus").textContent = "● Online";
    $("peerStatus").textContent = "Ready";
    setStatus("Your device is ready.");
    $("qrcode").innerHTML = "";

    if (window.QRCode) {
      new QRCode($("qrcode"), {
        text: id,
        width: 150,
        height: 150
      });
    }
  });

  peer.on("connection", conn => {
    if (connection && connection.open) {
      conn.close();
      return;
    }
    attachConnection(conn);
  });

  peer.on("error", error => {
    console.error(error);
    setStatus("Connection error: " + error.type);
    $("networkStatus").textContent = "● Connection issue";
  });

  peer.on("disconnected", () => {
    $("networkStatus").textContent = "● Disconnected";
    setStatus("Signalling connection lost. Reconnecting...");
    peer.reconnect();
  });
}

function attachConnection(conn) {
  connection = conn;

  conn.on("open", () => {
    $("connectionStatus").textContent =
      "🟢 Connected to " + conn.peer;
    $("networkStatus").textContent = "● Connected";
    setStatus("Connected successfully.");
    $("peerStatus").textContent = "Connected";
    updateConnectionUI(true);
  });

  conn.on("data", data => {
    handleIncomingData(data);
  });

  conn.on("close", () => {
    if (connection === conn) {
      connection = null;
      updateConnectionUI(false);
      $("peerStatus").textContent = "Disconnected";
      setStatus("Device disconnected.");
    }
  });

  conn.on("error", error => {
    console.error(error);
    setStatus("Data connection error.");
  });
}

function connectToDevice() {
  const id = $("remoteId").value.trim();

  if (!id) {
    alert("Enter a device ID first.");
    return;
  }

  if (!peer || peer.destroyed) {
    alert("Your device is not ready. Refresh the page.");
    return;
  }

  if (id === peer.id) {
    alert("You cannot connect to your own device.");
    return;
  }

  if (connection && connection.open) {
    alert("A device is already connected.");
    return;
  }

  setStatus("Connecting to device...");
  $("connectionStatus").textContent = "Connecting...";

  const conn = peer.connect(id, {
    reliable: true,
    serialization: "binary"
  });

  attachConnection(conn);
}

function sendMessage(message) {
  if (!connection || !connection.open) {
    throw new Error("Device is not connected.");
  }
  connection.send(message);
}

function waitForMessage(expectedType, timeout = 30000) {
  return new Promise((resolve, reject) => {
    if (activeSender) {
      activeSender.waitReject = reject;
    }

    const timer = setTimeout(() => {
      if (activeSender) activeSender.waitReject = null;
      reject(new Error("Transfer timed out. Check the connection."));
    }, timeout);

    const oldHandler = waitHandler;

    waitHandler = data => {
      if (data && data.type === expectedType) {
        clearTimeout(timer);
        waitHandler = oldHandler;
        if (activeSender) activeSender.waitReject = null;
        resolve(data);
      } else if (oldHandler) {
        oldHandler(data);
      }
    };
  });
}

let waitHandler = null;
let receiveState = null;

function handleIncomingData(data) {
  if (waitHandler && !(data instanceof ArrayBuffer)) {
    waitHandler(data);
    return;
  }

  if (data && data.type === "offer") {
    receiveOffer(data);
    return;
  }

  if (data && data.type === "ready") {
    return;
  }

  if (data && data.type === "cancel") {
    receiveState = null;
    currentTransfer = null;
    clearTransfer();
    $("receivedFiles").textContent = "Transfer cancelled.";
    return;
  }

  if (data && data.type === "chunk") {
    if (!receiveState) return;

    receiveState.chunks.push(data.data);
    receiveState.received += data.data.byteLength;

    const percent = receiveState.size
      ? receiveState.received / receiveState.size * 100
      : 100;

    renderTransfer(
      "Receiving: " + receiveState.name,
      percent
    );

    sendMessage({ type: "ack" });
    return;
  }

  if (data && data.type === "end") {
    finishReceiving(data);
    return;
  }

  if (data && data.type === "pause") {
    if (receiveState) {
      receiveState.paused = true;
      $("receivedFiles").textContent = "Sender paused the transfer.";
    }
    return;
  }

  if (data && data.type === "resume") {
    if (receiveState) {
      receiveState.paused = false;
      $("receivedFiles").textContent = "Transfer resumed.";
    }
  }
}

async function receiveOffer(data) {
  if (receiveState) {
    sendMessage({ type: "reject" });
    return;
  }

  const approved = confirm(
    "Incoming file:\n\n" +
    data.name +
    "\nSize: " + formatSize(data.size) +
    "\n\nAccept this file?"
  );

  if (!approved) {
    sendMessage({ type: "reject" });
    return;
  }

  receiveState = {
    name: data.name,
    size: data.size,
    mime: data.mime,
    chunks: [],
    received: 0
  };

  currentTransfer = { direction: "receive" };

  renderTransfer("Preparing to receive: " + data.name, 0);
  sendMessage({ type: "ready" });
}

async function sha256(blob) {
  if (!crypto.subtle) {
    throw new Error("Secure browser context required for file verification.");
  }

  const buffer = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buffer);

  return Array.from(new Uint8Array(hash))
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function finishReceiving(data) {
  if (!receiveState) return;

  const state = receiveState;
  receiveState = null;

  const blob = new Blob(state.chunks, {
    type: state.mime || "application/octet-stream"
  });

  renderTransfer("Verifying: " + state.name, 100);

  try {
    const hash = await sha256(blob);

    if (hash !== data.hash) {
      throw new Error("File integrity verification failed.");
    }

    const url = URL.createObjectURL(blob);

    const item = document.createElement("div");
    item.className = "file-item";

    const info = document.createElement("div");
    const title = document.createElement("strong");
    const detail = document.createElement("small");
    title.textContent = state.name;
    detail.textContent = formatSize(blob.size) + " • Verified";
    info.append(title, detail);

    const download = document.createElement("button");
    download.className = "primary-btn";
    download.textContent = "Download";
    download.addEventListener("click", () => {
      const a = document.createElement("a");
      a.href = url;
      a.download = state.name;
      a.click();
    });

    item.append(info, download);

    if ($("receivedFiles").querySelector(".empty-state")) {
      $("receivedFiles").innerHTML = "";
    }

    $("receivedFiles").prepend(item);
    addHistory(state.name, blob.size, "Received");

    renderTransfer("File received and verified", 100);
    setTimeout(clearTransfer, 4000);
  } catch (error) {
    console.error(error);
    renderTransfer("Verification failed", 0);
    $("receivedFiles").textContent = error.message;
  }
}

function addSenderControls() {
  const controls = $("transferControls");
  if (!controls) return;

  const pause = document.createElement("button");
  pause.className = "secondary-btn";
  pause.textContent = "Pause";
  pause.onclick = togglePause;

  const cancel = document.createElement("button");
  cancel.className = "secondary-btn";
  cancel.textContent = "Cancel";
  cancel.onclick = cancelTransfer;

  controls.append(pause, cancel);
}

function togglePause() {
  if (!activeSender) return;

  activeSender.paused = !activeSender.paused;

  if (activeSender.paused) {
    sendMessage({ type: "pause" });
  } else {
    sendMessage({ type: "resume" });
  }

  const button = $("transferControls")?.querySelector("button");
  if (button) {
    button.textContent = activeSender.paused ? "Resume" : "Pause";
  }
}

function cancelTransfer() {
  if (!activeSender) return;

  activeSender.cancelled = true;

  try {
    sendMessage({ type: "cancel" });
  } catch (error) {
    console.error(error);
  }

  if (activeSender.waitReject) {
    activeSender.waitReject(new Error("Transfer cancelled."));
  }

  activeSender = null;
  currentTransfer = null;
  clearTransfer();
}

async function sendFiles() {
  if (!connection || !connection.open) {
    alert("Connect to another device first.");
    return;
  }

  if (!selectedFiles.length || activeSender) return;

  const files = [...selectedFiles];

  activeSender = {
    paused: false,
    cancelled: false,
    waitReject: null
  };

  try {
    for (const file of files) {
      if (activeSender.cancelled) break;

      const hash = await sha256(file);

      sendMessage({
        type: "offer",
        name: file.name,
        size: file.size,
        mime: file.type,
        hash
      });

      const response = await waitForMessage("ready");

      if (response.type !== "ready") {
        throw new Error("Receiver did not accept the file.");
      }

      currentTransfer = { direction: "send" };

      let offset = 0;
      const startTime = Date.now();

      renderTransfer("Sending: " + file.name, 0);
      addSenderControls();

      while (offset < file.size) {
        if (!activeSender || activeSender.cancelled) {
          throw new Error("Transfer cancelled.");
        }

        while (activeSender.paused) {
          await new Promise(resolve => setTimeout(resolve, 200));

          if (activeSender.cancelled) {
            throw new Error("Transfer cancelled.");
          }
        }

        const end = Math.min(offset + CHUNK_SIZE, file.size);
        const buffer = await file.slice(offset, end).arrayBuffer();

        sendMessage({
          type: "chunk",
          data: buffer
        });

        await waitForMessage("ack");

        offset = end;

        const percent = file.size ? offset / file.size * 100 : 100;
        const elapsed = Math.max((Date.now() - startTime) / 1000, 0.1);
        const speed = formatSize(offset / elapsed) + "/s";

        renderTransfer(
          "Sending: " + file.name,
          percent,
          "• " + speed
        );

        addSenderControls();
      }

      sendMessage({ type: "end", hash });

      addHistory(file.name, file.size, "Sent");
    }

    if (activeSender && !activeSender.cancelled) {
      renderTransfer("All files sent successfully", 100);
      selectedFiles = [];
      renderSelectedFiles();
      setTimeout(clearTransfer, 4000);
    }
  } catch (error) {
    console.error(error);
    renderTransfer(error.message, 0);
  } finally {
    activeSender = null;
    currentTransfer = null;
  }
}

function startScanner() {
  if (!window.Html5Qrcode) {
    alert("QR scanner library could not load.");
    return;
  }

  if (scanner) return;

  scanner = new Html5Qrcode("reader");

  scanner.start(
    { facingMode: "environment" },
    { fps: 10, qrbox: 220 },
    async decodedText => {
      $("remoteId").value = decodedText.trim();

      await stopScanner();
      connectToDevice();
    },
    () => {}
  ).catch(error => {
    console.error(error);
    alert("Camera unavailable. Allow camera permission and use HTTPS.");
    scanner = null;
  });
}

async function stopScanner() {
  if (scanner) {
    try {
      await scanner.stop();
      scanner.clear();
    } catch (error) {
      console.error(error);
    }
    scanner = null;
  }
}

$("copyIdBtn").addEventListener("click", async () => {
  const id = $("myId").textContent;

  if (!id || id === "Generating ID...") return;

  try {
    await navigator.clipboard.writeText(id);
    $("copyIdBtn").textContent = "Copied!";
    setTimeout(() => $("copyIdBtn").textContent = "Copy ID", 1500);
  } catch {
    alert("Copy unavailable. Select and copy your device ID manually.");
  }
});

$("connectBtn").addEventListener("click", connectToDevice);
$("sendBtn").addEventListener("click", sendFiles);
$("scanBtn").addEventListener("click", startScanner);

$("chooseFilesBtn").addEventListener("click", () => {
  $("fileInput").click();
});

$("chooseFolderBtn").addEventListener("click", () => {
  $("folderInput").click();
});

$("fileInput").addEventListener("change", event => {
  selectedFiles = [...selectedFiles, ...Array.from(event.target.files)];
  renderSelectedFiles();
  event.target.value = "";
});

$("folderInput").addEventListener("change", event => {
  selectedFiles = [...selectedFiles, ...Array.from(event.target.files)];
  renderSelectedFiles();
  event.target.value = "";
});

$("selectedFiles").addEventListener("click", event => {
  const button = event.target.closest("[data-remove]");
  if (!button) return;

  selectedFiles.splice(Number(button.dataset.remove), 1);
  renderSelectedFiles();
});

$("clearHistoryBtn").addEventListener("click", () => {
  if (!confirm("Clear all transfer history?")) return;

  historyItems = [];
  localStorage.removeItem("p2pHistory");
  renderHistory();
});

$("themeBtn").addEventListener("click", () => {
  document.body.classList.toggle("light-theme");

  const light = document.body.classList.contains("light-theme");
  $("themeBtn").textContent = light ? "☀️" : "🌙";

  localStorage.setItem("p2pTheme", light ? "light" : "dark");
});

if (localStorage.getItem("p2pTheme") === "light") {
  document.body.classList.add("light-theme");
  $("themeBtn").textContent = "☀️";
}

renderHistory();
renderSelectedFiles();
setupPeer();
