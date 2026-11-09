/**
 * Plain-browser Watch Hub viewer, served at GET /watch/:sessionId (see index.ts).
 * Fixes WebRTC video autoplay black-screen issue across Chrome, Safari, Edge, FireTV, and Smart TVs.
 */
export const renderWatchViewerPage = (sessionId: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mistreal Live Stream Watch</title>
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: #000; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; overflow: hidden; }
  #stage { position: relative; width: 100vw; height: 100vh; display: flex; align-items: center; justify-content: center; background: #050505; }
  video { width: 100%; height: 100%; object-fit: contain; background: #000; }
  #overlay { position: absolute; top: 0; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; background: rgba(0,0,0,0.7); cursor: pointer; z-index: 10; }
  .badge { background: #ef4444; color: white; padding: 6px 14px; border-radius: 20px; font-weight: bold; font-size: 13px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 12px; }
  .btn { background: #2563eb; color: white; padding: 14px 28px; border-radius: 12px; font-weight: bold; font-size: 16px; border: none; cursor: pointer; box-shadow: 0 4px 14px rgba(37,99,235,0.4); }
  #status { position: absolute; bottom: 24px; left: 0; right: 0; text-align: center; font-size: 14px; color: #4ade80; font-weight: bold; text-shadow: 0 2px 4px rgba(0,0,0,0.8); z-index: 5; }
</style>
</head>
<body>
<div id="stage">
  <video id="remoteVideo" autoplay playsinline muted></video>
  <div id="overlay">
    <div class="badge">🔴 LIVE STREAM AVAILABLE</div>
    <button class="btn" id="playBtn">▶ TAP TO START WATCHING LIVE</button>
  </div>
  <div id="status">Connecting to Broadcast...</div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
(function () {
  var sessionId = ${JSON.stringify(sessionId)};
  var deviceId = 'web-' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  var statusEl = document.getElementById('status');
  var videoEl = document.getElementById('remoteVideo');
  var overlayEl = document.getElementById('overlay');
  var playBtn = document.getElementById('playBtn');
  var pc = null;

  function setStatus(text) { statusEl.textContent = text; }

  function startVideoPlayback() {
    videoEl.muted = false;
    videoEl.play().then(function() {
      overlayEl.style.display = 'none';
      setStatus('🔴 LIVE BROADCAST ACTIVE');
    }).catch(function(err) {
      videoEl.muted = true;
      videoEl.play().then(function() {
        overlayEl.style.display = 'none';
        setStatus('🔴 LIVE BROADCAST ACTIVE (MUTED)');
      });
    });
  }

  overlayEl.addEventListener('click', startVideoPlayback);
  playBtn.addEventListener('click', startVideoPlayback);

  var socket = io('/watch', { forceNew: true });

  socket.on('connect', function () {
    socket.emit('viewer:join', { sessionId: sessionId, deviceId: deviceId }, function (ack) {
      if (!ack || !ack.success) {
        setStatus((ack && ack.error) || 'Could not join — check the session code');
        return;
      }
      setStatus('Waiting for host broadcast signal...');
    });
  });

  socket.on('signal:offer', function (payload) {
    if (pc || !payload || !payload.sdp) return;
    var hostPeerId = payload.fromSocketId;

    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] });

    pc.onicecandidate = function (e) {
      if (!e.candidate) return;
      socket.emit('signal:ice', {
        toSocketId: hostPeerId,
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex
      });
    };

    pc.ontrack = function (e) {
      if (e.streams && e.streams[0]) {
        videoEl.srcObject = e.streams[0];
      } else if (e.track) {
        var stream = new MediaStream([e.track]);
        videoEl.srcObject = stream;
      }
      videoEl.play().catch(function() {});
      setStatus('🔴 STREAM RECEIVED — TAP SCREEN TO UNMUTE');
    };

    pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
      .then(function () { return pc.createAnswer(); })
      .then(function (answer) {
        return pc.setLocalDescription(answer).then(function () { return answer; });
      })
      .then(function (answer) {
        socket.emit('signal:answer', { toSocketId: hostPeerId, sdp: answer.sdp });
      })
      .catch(function (err) { setStatus('Connection error: ' + err.message); });
  });

  socket.on('signal:ice', function (payload) {
    if (!pc || !payload || !payload.candidate) return;
    pc.addIceCandidate({
      candidate: payload.candidate,
      sdpMid: payload.sdpMid,
      sdpMLineIndex: payload.sdpMLineIndex || 0
    }).catch(function () {});
  });

  socket.on('host:stopped', function () {
    setStatus('Host ended the live broadcast');
    if (pc) { pc.close(); pc = null; }
  });

  socket.on('disconnect', function () {
    setStatus('Disconnected from server');
  });
})();
</script>
</body>
</html>`;
