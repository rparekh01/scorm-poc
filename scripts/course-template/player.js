(function () {
  var C = window.COURSE;
  var total = C.steps.length;            // step index `total` is the quiz
  var $ = function (id) { return document.getElementById(id); };

  function findAPI(win) {
    for (var i = 0; i < 10 && win; i++) {
      try { if (win.API) return win.API; } catch (e) { return null; } // cross-origin: blocked
      if (win === win.parent) break;
      win = win.parent;
    }
    return null;
  }
  var api = findAPI(window);
  var started = Date.now();
  var finished = false;
  var state = { step: 0, done: [] };

  function get(k) { return api ? api.LMSGetValue(k) : ""; }
  function set(k, v) { if (api) api.LMSSetValue(k, String(v)); }
  function commit() { if (api) api.LMSCommit(""); }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function sessionTime() {
    var s = Math.floor((Date.now() - started) / 1000);
    return pad(Math.floor(s / 3600)) + ":" + pad(Math.floor(s / 60) % 60) + ":" + pad(s % 60);
  }
  function finish() {
    if (!api || finished) return;
    finished = true;
    set("cmi.core.session_time", sessionTime());
    api.LMSFinish("");
  }

  $("title").textContent = C.title;
  document.title = C.title;

  if (!api) {
    $("banner").textContent = "LMS API not found (cross-origin or missing). Progress will not be tracked.";
    $("banner").hidden = false;
  } else {
    api.LMSInitialize("");
    var status = get("cmi.core.lesson_status");
    if (status === "" || status === "not attempted") set("cmi.core.lesson_status", "incomplete");
    try { var sd = JSON.parse(get("cmi.suspend_data") || "{}"); if (sd.done) state.done = sd.done; } catch (e) {}
    var loc = parseInt(get("cmi.core.lesson_location"), 10);
    if (!isNaN(loc) && loc >= 0 && loc <= total) state.step = loc;
    commit();
  }

  function save() {
    set("cmi.core.lesson_location", state.step);
    set("cmi.suspend_data", JSON.stringify({ done: state.done }));
    set("cmi.core.session_time", sessionTime());
    commit();
  }
  function allowed(i) {
    for (var j = 0; j < i; j++) if (!state.done[j]) return false;
    return true;
  }
  function go(i) { state.step = i; save(); render(); }
  function complete(i) { state.done[i] = true; save(); go(i + 1); }

  function renderNav() {
    var ul = $("steps");
    ul.innerHTML = "";
    for (var i = 0; i <= total; i++) {
      (function (i) {
        var li = document.createElement("li");
        li.textContent = i < total ? (i + 1) + ". " + C.steps[i].title : "Quiz";
        if (state.done[i]) li.className += " done";
        if (allowed(i)) { li.className += " open"; li.onclick = function () { go(i); }; }
        if (i === state.step) li.className += " current";
        ul.appendChild(li);
      })(i);
    }
  }

  function renderStep(i, main) {
    var s = C.steps[i];
    var h = "<h2>" + s.title + "</h2>";
    if (s.type === "video") {
      h += '<video id="vid" controls preload="metadata" width="720" src="' + s.src + '"></video>' +
           '<p class="muted">Watch the video to the end to continue. Length: about ' + s.minutes + ' minutes.</p>';
    } else {
      if (s.image) h += '<img src="' + s.image + '" alt="" width="720">';
      h += s.body.map(function (p) { return "<p>" + p + "</p>"; }).join("");
    }
    h += '<p><button id="back"' + (i === 0 ? " disabled" : "") + '>Back</button>' +
         '<button id="next"' + (state.done[i] || s.type !== "video" ? "" : " disabled") + '>Continue</button>' +
         (s.type === "video" && !state.done[i] ? '<button id="skip">Mark as watched (test shortcut)</button>' : "") + "</p>";
    main.innerHTML = h;
    $("back").onclick = function () { go(i - 1); };
    $("next").onclick = function () { complete(i); };
    if (s.type === "video") {
      $("vid").onended = function () { $("next").disabled = false; };
      var skip = $("skip");
      if (skip) skip.onclick = function () { complete(i); };
    }
  }

  function renderQuiz(main) {
    var h = "<h2>Quiz</h2><p class='muted'>Pass mark: " + C.passMark + "%</p>";
    C.quiz.forEach(function (q, qi) {
      h += '<div class="q"><strong>' + (qi + 1) + ". " + q.q + "</strong><br>";
      q.options.forEach(function (o, oi) {
        h += '<label><input type="radio" name="q' + qi + '" value="' + oi + '"> ' + o + "</label><br>";
      });
      h += "</div>";
    });
    h += '<p><button id="back">Back</button><button id="submit">Submit answers</button></p><div id="result"></div>';
    main.innerHTML = h;
    $("back").onclick = function () { go(total - 1); };
    $("submit").onclick = function () {
      var right = 0;
      C.quiz.forEach(function (q, qi) {
        var el = document.querySelector('input[name="q' + qi + '"]:checked');
        if (el && parseInt(el.value, 10) === q.answer) right++;
      });
      var pct = Math.round((right / C.quiz.length) * 100);
      var passed = pct >= C.passMark;
      set("cmi.core.score.min", 0);
      set("cmi.core.score.max", 100);
      set("cmi.core.score.raw", pct);
      set("cmi.core.lesson_status", passed ? "passed" : "failed");
      if (passed) state.done[total] = true;
      save();
      $("result").className = "result " + (passed ? "pass" : "fail");
      $("result").textContent = passed
        ? "Score " + pct + "%. Passed. The course is complete."
        : "Score " + pct + "%. Not passed. Review the steps and try again.";
      if (passed) { $("submit").disabled = true; renderNav(); finish(); }
    };
  }

  function render() {
    renderNav();
    var main = $("content");
    if (state.step < total) renderStep(state.step, main); else renderQuiz(main);
  }

  window.addEventListener("beforeunload", function () { if (api && !finished) { save(); finish(); } });
  render();
})();
