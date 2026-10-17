/**
 * Plain-browser Watch Hub viewer, served at GET /watch/:sessionId (see
 * index.ts). Speaks watchSignalingService.ts's '/watch' Socket.IO protocol
 * exactly as WatchViewerViewModel.kt does — join, wait for an offer, answer,
 * trade ICE candidates — but with the browser's native RTCPeerConnection in
 * place of stream-webrtc-android, so any device with a browser (a computer,
 * a smart TV) can watch a Mistreal host's live screen with no app install.
 */
export const renderWatchViewerPage = (sessionId: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mistreal Watch</title>
<style>
  html, body { margin: 0; height: 100%; background: #0b0d10; color: #e8eaed; font-family: -apple-system, system-ui, sans-serif; }
  #stage { position: relative; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
  video { max-width: 100%; max-height: 100%; background: #000; }
  #status { position: absolute; bottom: 24px; left: 0; right: 0; text-align: center; font-size: 14px; color: #9aa0a6; letter-spacing: 0.02em; }
</style>
</head>
<body>
<div id="stage">
  <video id="remoteVideo" autoplay playsinline></video>
  <div id="status">Connecting…</div>
</div>
<script src="/socket.io/socket.io.js"></script>
<script>
(function () {
  var sessionId = ${JSON.stringify(sessionId)};
  var deviceId = 'web-' + Math.random().toString(16).slice(2) + Date.now().toString(16);
  var statusEl = document.getElementById('status');
  var videoEl = document.getElementById('remoteVideo');
  var pc = null;

  function setStatus(text) { statusEl.textContent = text; }

  var socket = io('/watch', { forceNew: true });

  socket.on('connect', function () {
    socket.emit('viewer:join', { sessionId: sessionId, deviceId: deviceId }, function (ack) {
      if (!ack || !ack.success) {
        setStatus((ack && ack.error) || 'Could not join — check the code and try again');
        return;
      }
      setStatus('Waiting for host…');
    });
  });

  socket.on('signal:offer', function (payload) {
    if (pc || !payload || !payload.sdp) return;
    var hostPeerId = payload.fromSocketId;

    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });

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
      videoEl.srcObject = e.streams[0];
      setStatus('Connected');
    };

    pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp })
      .then(function () { return pc.createAnswer(); })
      .then(function (answer) {
        return pc.setLocalDescription(answer).then(function () { return answer; });
      })
      .then(function (answer) {
        socket.emit('signal:answer', { toSocketId: hostPeerId, sdp: answer.sdp });
      })
      .catch(function (err) { setStatus('Connection failed: ' + err.message); });
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
    setStatus('Host ended the session');
    if (pc) { pc.close(); pc = null; }
  });

  socket.on('disconnect', function () {
    setStatus('Disconnected');
  });
})();
</script>
</body>
</html>`;
