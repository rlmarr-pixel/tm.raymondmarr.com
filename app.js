'use strict';

const STORAGE_KEY = 'tm-workspace:v1';
const APP_ID = 'tm-workspace';
const SCHEMA_VERSION = 1;
const TZ = 'America/Los_Angeles';
const TABS = ['meetings', 'roles', 'speeches', 'practice', 'feedback', 'events'];
const WEEKDAY_MAP = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const DEFAULT_ROLES = [
  'Timer',
  'Evaluator',
  'Sergeant at Arms',
  'Toastmaster',
  'General Evaluator',
  'Grammarian',
  'Ah-Counter',
  'Table Topics Master'
];

const CLUBS = [
  {
    id: 'salinas-sunrise',
    name: 'Salinas Sunrise Toastmasters',
    weekday: 2,
    start: '06:45',
    end: '07:45',
    optional: false
  },
  {
    id: 'san-jose',
    name: 'San Jose Toastmasters',
    weekday: 3,
    start: '07:00',
    end: '08:15',
    optional: true
  }
];

const MEETING_STATUSES = [
  { id: 'upcoming', label: 'Upcoming' },
  { id: 'attended', label: 'Attended' },
  { id: 'missed', label: 'Missed' },
  { id: 'cancelled', label: 'Cancelled' }
];

const SPEECH_STATUSES = [
  { id: 'draft', label: 'Draft' },
  { id: 'scheduled', label: 'Scheduled' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'archived', label: 'Archived' }
];

const TIMER_PRESETS = [
  { id: 'topics', label: 'Table Topics', green: 60, yellow: 90, red: 120 },
  { id: 'eval', label: 'Evaluation', green: 120, yellow: 150, red: 180 },
  { id: 'ice', label: 'Ice Breaker (4–6)', green: 240, yellow: 300, red: 360 },
  { id: 's57', label: 'Speech (5–7)', green: 300, yellow: 360, red: 420 },
  { id: 's68', label: 'Speech (6–8)', green: 360, yellow: 420, red: 480 },
  { id: 's810', label: 'Speech (8–10)', green: 480, yellow: 540, red: 600 }
];

let state = null;
let currentTab = 'meetings';
let meetingFilter = 'all';
let dialogCtl = null;
let practiceSpeechId = '';
let timer = createTimerState();

function createTimerState() {
  const preset = TIMER_PRESETS[3];
  return {
    running: false,
    startedAt: null,
    accumulated: 0,
    bands: { green: preset.green, yellow: preset.yellow, red: preset.red },
    presetId: 's57',
    raf: null,
    lastCue: 'clear'
  };
}

function uid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function str(value) {
  return value == null ? '' : String(value).trim();
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function partsInZone(date, timeZone) {
  const tz = timeZone || TZ;
  const map = {};
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  for (let i = 0; i < formatted.length; i += 1) {
    const part = formatted[i];
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return map;
}

function ymdInZone(date, timeZone) {
  const parts = partsInZone(date, timeZone);
  return parts.year + '-' + parts.month + '-' + parts.day;
}

function weekdayInZone(date, timeZone) {
  const parts = partsInZone(date, timeZone);
  return WEEKDAY_MAP[parts.weekday];
}

function addDaysYmd(ymd, days) {
  const bits = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(bits[0], bits[1] - 1, bits[2] + days));
  return date.toISOString().slice(0, 10);
}

function weekdayFromYmd(ymd) {
  const bits = ymd.split('-').map(Number);
  return new Date(Date.UTC(bits[0], bits[1] - 1, bits[2])).getUTCDay();
}

function zonedDate(ymd, hm, timeZone) {
  const tz = timeZone || TZ;
  const ymdBits = ymd.split('-').map(Number);
  const hmBits = hm.split(':').map(Number);
  const year = ymdBits[0];
  const month = ymdBits[1];
  const day = ymdBits[2];
  const hour = hmBits[0];
  const minute = hmBits[1] || 0;
  let utc = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 4; i += 1) {
    const parts = partsInZone(new Date(utc), tz);
    const got = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    const want = Date.UTC(year, month - 1, day, hour, minute, 0);
    const delta = want - got;
    if (delta === 0) break;
    utc += delta;
  }
  return new Date(utc);
}

function upcomingOccurrences(club, fromDate, count, timeZone) {
  const tz = timeZone || TZ;
  const want = count == null ? 8 : count;
  const from = fromDate || new Date();
  const results = [];
  const startYmd = ymdInZone(from, tz);
  for (let i = 0; i < 7 * want + 2 && results.length < want; i += 1) {
    const cursor = i === 0 ? startYmd : addDaysYmd(startYmd, i);
    if (weekdayFromYmd(cursor) !== club.weekday) continue;
    const endAt = zonedDate(cursor, club.end, tz);
    if (endAt <= from) continue;
    const startAt = zonedDate(cursor, club.start, tz);
    results.push({
      id: club.id + ':' + cursor,
      clubId: club.id,
      date: cursor,
      start: club.start,
      end: club.end,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString()
    });
  }
  return results;
}

function formatClock(hm) {
  const bits = String(hm).split(':').map(Number);
  const hour = bits[0];
  const minute = bits[1] || 0;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  const hour12 = ((hour + 11) % 12) + 1;
  return hour12 + ':' + String(minute).padStart(2, '0') + ' ' + suffix;
}

function formatTimeRange(start, end) {
  return formatClock(start) + '–' + formatClock(end) + ' Pacific';
}

function formatLongDate(ymd) {
  const bits = ymd.split('-').map(Number);
  const weekday = WEEKDAY_NAMES[weekdayFromYmd(ymd)];
  return weekday + ', ' + MONTHS[bits[1] - 1] + ' ' + bits[2] + ', ' + bits[0];
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return minutes + ':' + String(rest).padStart(2, '0');
}

function timingBands(minMinutes, maxMinutes) {
  const green = Math.round(Number(minMinutes) * 60);
  const red = Math.round(Number(maxMinutes) * 60);
  const yellow = Math.round((green + red) / 2);
  return { green: green, yellow: yellow, red: red };
}

function cueFromElapsed(elapsedSec, bands) {
  const elapsed = Number(elapsedSec) || 0;
  if (elapsed < bands.green) return 'clear';
  if (elapsed < bands.yellow) return 'green';
  if (elapsed < bands.red) return 'yellow';
  return 'red';
}

function cueLabel(cue) {
  if (cue === 'green') return 'Green';
  if (cue === 'yellow') return 'Yellow';
  if (cue === 'red') return 'Red';
  return 'Clear';
}

function statusLabel(list, id) {
  for (let i = 0; i < list.length; i += 1) {
    if (list[i].id === id) return list[i].label;
  }
  return id;
}

function defaultState() {
  return {
    version: SCHEMA_VERSION,
    meetings: {},
    roles: DEFAULT_ROLES.map(function (name) {
      return { id: uid(), name: name };
    }),
    speeches: [
      {
        id: uid(),
        title: 'History of Attention',
        projectPathway: '',
        introBio: '',
        timingMin: 5,
        timingMax: 7,
        audienceGoals: '',
        status: 'draft',
        meetingId: '',
        createdAt: new Date().toISOString()
      }
    ],
    practices: [],
    feedback: [],
    events: []
  };
}

function coerceSpeech(raw) {
  if (!isPlainObject(raw) || !str(raw.title)) return null;
  const status = SPEECH_STATUSES.some(function (item) { return item.id === raw.status; }) ? raw.status : 'draft';
  const timingMin = num(raw.timingMin, 5);
  const timingMax = num(raw.timingMax, Math.max(7, timingMin));
  if (timingMin < 0 || timingMax < timingMin || timingMax > 60) return null;
  return {
    id: str(raw.id) || uid(),
    title: str(raw.title),
    projectPathway: str(raw.projectPathway),
    introBio: str(raw.introBio),
    timingMin: timingMin,
    timingMax: timingMax,
    audienceGoals: str(raw.audienceGoals),
    status: status,
    meetingId: str(raw.meetingId),
    createdAt: str(raw.createdAt) || new Date().toISOString()
  };
}

function coercePractice(raw) {
  if (!isPlainObject(raw)) return null;
  const durationSeconds = num(raw.durationSeconds, NaN);
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) return null;
  return {
    id: str(raw.id) || uid(),
    speechId: str(raw.speechId),
    date: str(raw.date) || ymdInZone(new Date()),
    durationSeconds: Math.round(durationSeconds),
    usedNotes: !!raw.usedNotes,
    selfNotes: str(raw.selfNotes),
    createdAt: str(raw.createdAt) || new Date().toISOString()
  };
}

function coerceFollowUp(raw) {
  if (typeof raw === 'string' && raw.trim()) {
    return { id: uid(), text: raw.trim(), done: false };
  }
  if (!isPlainObject(raw) || !str(raw.text)) return null;
  return { id: str(raw.id) || uid(), text: str(raw.text), done: !!raw.done };
}

function coerceFeedback(raw) {
  if (!isPlainObject(raw)) return null;
  const followUps = Array.isArray(raw.followUps) ? raw.followUps.map(coerceFollowUp).filter(Boolean) : [];
  return {
    id: str(raw.id) || uid(),
    date: str(raw.date) || ymdInZone(new Date()),
    speechId: str(raw.speechId),
    source: str(raw.source),
    comments: str(raw.comments),
    followUps: followUps,
    createdAt: str(raw.createdAt) || new Date().toISOString()
  };
}

function coerceEvent(raw) {
  if (!isPlainObject(raw) || !str(raw.title)) return null;
  const type = raw.type === 'open-house' || raw.type === 'special' ? raw.type : 'special';
  function rows(list, mapper) {
    return Array.isArray(list) ? list.map(mapper).filter(Boolean) : [];
  }
  return {
    id: str(raw.id) || uid(),
    title: str(raw.title),
    date: str(raw.date),
    type: type,
    runOfShow: rows(raw.runOfShow, function (row) {
      if (!isPlainObject(row)) return null;
      return { id: str(row.id) || uid(), time: str(row.time), item: str(row.item), who: str(row.who) };
    }),
    intros: rows(raw.intros, function (row) {
      if (!isPlainObject(row)) return null;
      return { id: str(row.id) || uid(), person: str(row.person), text: str(row.text) };
    }),
    setupChecklist: rows(raw.setupChecklist, function (row) {
      if (!isPlainObject(row) || !str(row.text)) return null;
      return { id: str(row.id) || uid(), text: str(row.text), done: !!row.done };
    }),
    roles: rows(raw.roles, function (row) {
      if (!isPlainObject(row)) return null;
      return { id: str(row.id) || uid(), role: str(row.role), person: str(row.person) };
    }),
    createdAt: str(raw.createdAt) || new Date().toISOString()
  };
}

function coerceState(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: 'Backup data must be an object.' };
  const next = defaultState();
  if (raw.meetings != null) {
    if (!isPlainObject(raw.meetings)) return { ok: false, error: 'meetings must be an object.' };
    next.meetings = {};
    const ids = Object.keys(raw.meetings);
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      if (!/^[a-z0-9-]+:\d{4}-\d{2}-\d{2}$/.test(id)) {
        return { ok: false, error: 'Invalid meeting id: ' + id };
      }
      const rec = raw.meetings[id];
      if (!isPlainObject(rec)) return { ok: false, error: 'Meeting ' + id + ' is not an object.' };
      const status = MEETING_STATUSES.some(function (item) { return item.id === rec.status; }) ? rec.status : 'upcoming';
      next.meetings[id] = {
        notes: str(rec.notes),
        role: str(rec.role),
        status: status,
        uncertain: !!rec.uncertain
      };
    }
  }
  if (raw.roles != null) {
    if (!Array.isArray(raw.roles)) return { ok: false, error: 'roles must be an array.' };
    const roles = [];
    for (let i = 0; i < raw.roles.length; i += 1) {
      const role = raw.roles[i];
      if (typeof role === 'string' && role.trim()) {
        roles.push({ id: uid(), name: role.trim() });
      } else if (isPlainObject(role) && str(role.name)) {
        roles.push({ id: str(role.id) || uid(), name: str(role.name) });
      } else {
        return { ok: false, error: 'Each role needs a name.' };
      }
    }
    next.roles = roles;
  }
  if (raw.speeches != null) {
    if (!Array.isArray(raw.speeches)) return { ok: false, error: 'speeches must be an array.' };
    const speeches = raw.speeches.map(coerceSpeech);
    if (speeches.some(function (item) { return !item; })) {
      return { ok: false, error: 'One of the speeches is missing a title or has an invalid shape.' };
    }
    next.speeches = speeches;
  }
  if (raw.practices != null) {
    if (!Array.isArray(raw.practices)) return { ok: false, error: 'practices must be an array.' };
    const practices = raw.practices.map(coercePractice);
    if (practices.some(function (item) { return !item; })) {
      return { ok: false, error: 'One of the practice logs has an invalid shape.' };
    }
    next.practices = practices;
  }
  if (raw.feedback != null) {
    if (!Array.isArray(raw.feedback)) return { ok: false, error: 'feedback must be an array.' };
    const feedback = raw.feedback.map(coerceFeedback);
    if (feedback.some(function (item) { return !item; })) {
      return { ok: false, error: 'One of the feedback entries has an invalid shape.' };
    }
    next.feedback = feedback;
  }
  if (raw.events != null) {
    if (!Array.isArray(raw.events)) return { ok: false, error: 'events must be an array.' };
    const events = raw.events.map(coerceEvent);
    if (events.some(function (item) { return !item; })) {
      return { ok: false, error: 'One of the events is missing a title or has an invalid shape.' };
    }
    next.events = events;
  }
  next.version = SCHEMA_VERSION;
  return { ok: true, state: next };
}

function summarizeState(data) {
  return {
    meetings: Object.keys(data.meetings || {}).length,
    roles: (data.roles || []).length,
    speeches: (data.speeches || []).length,
    practices: (data.practices || []).length,
    feedback: (data.feedback || []).length,
    events: (data.events || []).length
  };
}

function buildExportPayload(data, now) {
  const when = now || new Date();
  return {
    app: APP_ID,
    version: SCHEMA_VERSION,
    exportedAt: when.toISOString(),
    data: JSON.parse(JSON.stringify(data))
  };
}

function parseAndValidateImport(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    return { ok: false, error: 'That file is not valid JSON.' };
  }
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'That file does not look like a workspace backup.' };
  }
  let raw = payload;
  if (isPlainObject(payload.data)) {
    if (payload.app && payload.app !== APP_ID) {
      return { ok: false, error: 'That JSON is not a Toastmasters Workspace export.' };
    }
    raw = payload.data;
  } else if (payload.app && payload.app !== APP_ID) {
    return { ok: false, error: 'That JSON is not a Toastmasters Workspace export.' };
  }
  const coerced = coerceState(raw);
  if (!coerced.ok) return coerced;
  return { ok: true, state: coerced.state, summary: summarizeState(coerced.state) };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const coerced = coerceState(parsed);
    return coerced.ok ? coerced.state : defaultState();
  } catch (err) {
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function clubById(id) {
  for (let i = 0; i < CLUBS.length; i += 1) {
    if (CLUBS[i].id === id) return CLUBS[i];
  }
  return null;
}

function speechById(id) {
  for (let i = 0; i < state.speeches.length; i += 1) {
    if (state.speeches[i].id === id) return state.speeches[i];
  }
  return null;
}

function getMergedOccurrences(fromDate, count) {
  const now = fromDate || new Date();
  const list = [];
  for (let i = 0; i < CLUBS.length; i += 1) {
    const club = CLUBS[i];
    const occs = upcomingOccurrences(club, now, count);
    for (let j = 0; j < occs.length; j += 1) {
      const occ = occs[j];
      const saved = state.meetings[occ.id] || {};
      list.push({
        id: occ.id,
        club: club,
        date: occ.date,
        start: occ.start,
        end: occ.end,
        startAt: occ.startAt,
        endAt: occ.endAt,
        notes: saved.notes || '',
        role: saved.role || '',
        status: saved.status || 'upcoming',
        uncertain: !!saved.uncertain
      });
    }
  }
  list.sort(function (a, b) { return a.startAt < b.startAt ? -1 : a.startAt > b.startAt ? 1 : 0; });
  return list;
}

function optionList(list, selected, emptyLabel) {
  let html = emptyLabel ? '<option value="">' + escapeHtml(emptyLabel) + '</option>' : '';
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    const id = item.id;
    const label = item.label || item.name || item.title;
    html += '<option value="' + escapeHtml(id) + '"' + (id === selected ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
  }
  return html;
}

function bindChrome() {
  document.getElementById('btn-export').addEventListener('click', exportData);
  document.getElementById('btn-import').addEventListener('click', function () {
    document.getElementById('import-file').click();
  });
  document.getElementById('btn-reset').addEventListener('click', resetData);
  document.getElementById('import-file').addEventListener('change', onImportFile);
  document.querySelector('.tabs-inner').addEventListener('click', function (event) {
    const tab = event.target.closest('[data-tab]');
    if (tab) showTab(tab.getAttribute('data-tab'));
  });
  document.querySelector('.tabs-inner').addEventListener('keydown', onTabKeydown);
  document.body.addEventListener('click', onBodyClick);
  document.body.addEventListener('change', onBodyChange);
  document.body.addEventListener('submit', onBodySubmit);
  document.addEventListener('keydown', onGlobalKeydown);
}

function onTabKeydown(event) {
  const tabs = Array.prototype.slice.call(document.querySelectorAll('.tabs-inner [role="tab"]'));
  const index = tabs.indexOf(event.target);
  if (index < 0) return;
  let next = null;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = tabs[(index + 1) % tabs.length];
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = tabs[(index - 1 + tabs.length) % tabs.length];
  else if (event.key === 'Home') next = tabs[0];
  else if (event.key === 'End') next = tabs[tabs.length - 1];
  if (!next) return;
  event.preventDefault();
  next.focus();
  showTab(next.getAttribute('data-tab'));
}

function tabFromHash() {
  const hash = (location.hash || '#meetings').replace(/^#/, '');
  return TABS.indexOf(hash) >= 0 ? hash : 'meetings';
}

function showTab(name, options) {
  const opts = options || {};
  currentTab = TABS.indexOf(name) >= 0 ? name : 'meetings';
  for (let i = 0; i < TABS.length; i += 1) {
    const tab = TABS[i];
    const panel = document.getElementById('panel-' + tab);
    const tabEl = document.getElementById('tab-' + tab);
    const selected = tab === currentTab;
    if (panel) panel.hidden = !selected;
    if (tabEl) {
      tabEl.setAttribute('aria-selected', selected ? 'true' : 'false');
      tabEl.tabIndex = selected ? 0 : -1;
    }
  }
  if (!opts.skipHash && location.hash !== '#' + currentTab) {
    history.replaceState(null, '', '#' + currentTab);
  }
  renderCurrent();
}

function renderCurrent() {
  if (currentTab === 'meetings') renderMeetings();
  else if (currentTab === 'roles') renderRoles();
  else if (currentTab === 'speeches') renderSpeeches();
  else if (currentTab === 'practice') renderPractice();
  else if (currentTab === 'feedback') renderFeedback();
  else if (currentTab === 'events') renderEvents();
}

function renderMeetings() {
  const upcoming = getMergedOccurrences(new Date(), 8);
  const nextRequired = upcoming.find(function (item) {
    return !item.club.optional && item.status === 'upcoming';
  }) || upcoming.find(function (item) { return !item.club.optional; });
  const nextOptional = upcoming.find(function (item) {
    return item.club.optional && item.status === 'upcoming';
  }) || upcoming.find(function (item) { return item.club.optional; });
  const filtered = upcoming.filter(function (item) {
    if (meetingFilter === 'regular') return !item.club.optional;
    if (meetingFilter === 'optional') return item.club.optional;
    return true;
  });
  let listHtml = '';
  for (let i = 0; i < filtered.length; i += 1) {
    listHtml += meetingCard(filtered[i], { featured: false });
  }
  document.getElementById('panel-meetings').innerHTML =
    '<div class="stack">' +
      '<div class="section-head"><div><h2>Next meeting</h2><p class="lede">Salinas Sunrise is shown every week. San Jose is listed as an optional meeting.</p></div></div>' +
      '<div class="hero-grid">' +
        (nextRequired ? meetingCard(nextRequired, { featured: true }) : '<div class="empty">No upcoming regular meeting was found.</div>') +
        (nextOptional ? meetingCard(nextOptional, { featured: true, optionalHero: true }) : '') +
      '</div>' +
      '<div class="section-head"><div><h2>Upcoming meetings</h2></div>' +
        '<div class="filter-row" role="group" aria-label="Filter meetings">' +
          filterButton('all', 'All') + filterButton('regular', 'Regular') + filterButton('optional', 'Optional') +
        '</div>' +
      '</div>' +
      '<div class="list">' + (listHtml || '<div class="empty">No meetings match this filter.</div>') + '</div>' +
    '</div>';
}

function filterButton(id, label) {
  const pressed = meetingFilter === id;
  return '<button type="button" class="btn' + (pressed ? ' btn-primary' : '') + '" data-meeting-filter="' + id + '" aria-pressed="' + pressed + '">' + label + '</button>';
}

function meetingCard(occ, options) {
  const opts = options || {};
  const optional = occ.club.optional;
  let eyebrow = 'Upcoming meeting';
  if (opts.featured && optional) eyebrow = 'Optional meeting';
  else if (opts.featured) eyebrow = 'Next regular meeting';
  else if (optional) eyebrow = 'Optional';
  const badges =
    (optional ? '<span class="badge optional">Optional</span>' : '') +
    '<span class="badge status-' + escapeHtml(occ.status) + '">' + escapeHtml(statusLabel(MEETING_STATUSES, occ.status)) + '</span>' +
    (occ.uncertain ? '<span class="badge uncertain">Details uncertain</span>' : '') +
    (occ.role ? '<span class="badge">' + escapeHtml(occ.role) + '</span>' : '<span class="muted">No role set</span>');
  return '<article class="card card-rail meeting-card' + (optional ? ' optional' : '') + '">' +
    '<p class="eyebrow">' + eyebrow + '</p>' +
    '<h3>' + escapeHtml(occ.club.name) + '</h3>' +
    '<p class="meta">' + escapeHtml(formatLongDate(occ.date)) + ' · ' + escapeHtml(formatTimeRange(occ.start, occ.end)) + '</p>' +
    '<div class="badge-row u-badge-gap">' + badges + '</div>' +
    (occ.notes ? '<p>' + escapeHtml(occ.notes) + '</p>' : '') +
    '<div class="row-actions"><button type="button" class="btn" data-edit-meeting="' + escapeHtml(occ.id) + '">Edit details</button></div>' +
  '</article>';
}

function renderRoles() {
  let rolesHtml = '';
  for (let i = 0; i < state.roles.length; i += 1) {
    const role = state.roles[i];
    rolesHtml += '<div class="role-item">' +
      '<label>Role name<input type="text" data-role-name="' + escapeHtml(role.id) + '" value="' + escapeHtml(role.name) + '" required></label>' +
      '<button type="button" class="icon-btn" data-delete-role="' + escapeHtml(role.id) + '" aria-label="Remove ' + escapeHtml(role.name) + '">Remove</button>' +
    '</div>';
  }
  document.getElementById('panel-roles').innerHTML =
    '<div class="stack">' +
      '<div class="card stack">' +
        '<div class="section-head"><h2>Role assignments</h2></div>' +
        '<p class="lede">Keep the club role list current. Choose a role on each meeting from this list, or write in something else when you edit a meeting.</p>' +
        '<div class="role-list">' + (rolesHtml || '<div class="empty">No roles yet. Add one below.</div>') + '</div>' +
        '<form data-form="add-role" class="form-grid two">' +
          '<label>New role name<input type="text" name="name" required maxlength="80" placeholder="For example, Speaker"></label>' +
          '<div class="row-actions u-align-end"><button type="submit" class="btn btn-primary">Add role</button></div>' +
        '</form>' +
      '</div>' +
      '<div class="card stack">' +
        '<div class="section-head"><h2>Timer role helper</h2></div>' +
        '<p class="lede">Use the green, yellow, and red cues while timing a speaker. The colors also appear as text, so the signal is not color-only.</p>' +
        timerPanelHtml('roles') +
      '</div>' +
    '</div>';
  updateTimerUI();
}

function timerPanelHtml(context) {
  const custom = timer.presetId === 'custom';
  let presets = '';
  for (let i = 0; i < TIMER_PRESETS.length; i += 1) {
    const preset = TIMER_PRESETS[i];
    presets += '<option value="' + preset.id + '"' + (timer.presetId === preset.id ? ' selected' : '') + '>' + escapeHtml(preset.label) + '</option>';
  }
  if (context === 'practice') {
    for (let i = 0; i < state.speeches.length; i += 1) {
      const speech = state.speeches[i];
      const value = 'speech:' + speech.id;
      const label = 'Speech: ' + speech.title + ' (' + speech.timingMin + '–' + speech.timingMax + ')';
      presets += '<option value="' + escapeHtml(value) + '"' + (timer.presetId === value ? ' selected' : '') + '>' + escapeHtml(label) + '</option>';
    }
  }
  presets += '<option value="custom"' + (custom ? ' selected' : '') + '>Custom</option>';
  return '<div class="stack">' +
    '<label>Timing target<select data-timer-preset>' + presets + '</select></label>' +
    '<div class="form-grid two" data-custom-bands' + (custom ? '' : ' hidden') + '>' +
      '<label>Green (minutes)<input type="number" min="0" step="0.5" data-band="green" value="' + (timer.bands.green / 60) + '"></label>' +
      '<label>Yellow (minutes)<input type="number" min="0" step="0.5" data-band="yellow" value="' + (timer.bands.yellow / 60) + '"></label>' +
      '<label>Red (minutes)<input type="number" min="0" step="0.5" data-band="red" value="' + (timer.bands.red / 60) + '"></label>' +
    '</div>' +
    '<div class="timer-board cue-clear" data-timer-board tabindex="0" aria-label="Rehearsal timer">' +
      '<div class="timer-face" data-timer-face aria-label="Elapsed time">0:00</div>' +
      '<div class="timer-cue" data-timer-cue aria-live="polite">Clear</div>' +
      '<p class="timer-bands" data-timer-bands></p>' +
    '</div>' +
    '<div class="row-actions">' +
      '<button type="button" class="btn btn-primary" data-timer-start>' + (timer.running ? 'Pause' : 'Start') + '</button>' +
      '<button type="button" class="btn" data-timer-reset>Reset</button>' +
      (context === 'practice' ? '<button type="button" class="btn" data-save-practice>Save practice log</button>' : '') +
    '</div>' +
  '</div>';
}

function renderSpeeches() {
  let cards = '';
  const sorted = state.speeches.slice().sort(function (a, b) {
    return (a.createdAt || '') < (b.createdAt || '') ? 1 : -1;
  });
  for (let i = 0; i < sorted.length; i += 1) {
    const speech = sorted[i];
    const meeting = speech.meetingId && describeMeeting(speech.meetingId);
    cards += '<article class="card">' +
      '<div class="badge-row"><span class="badge status-' + (speech.status === 'delivered' ? 'attended' : speech.status === 'draft' ? 'upcoming' : speech.status) + '">' + escapeHtml(statusLabel(SPEECH_STATUSES, speech.status)) + '</span>' +
      '<span class="badge">' + escapeHtml(String(speech.timingMin)) + '–' + escapeHtml(String(speech.timingMax)) + ' min</span></div>' +
      '<h3>' + escapeHtml(speech.title) + '</h3>' +
      (speech.projectPathway ? '<p class="meta">' + escapeHtml(speech.projectPathway) + '</p>' : '') +
      '<dl class="kv">' +
        (speech.introBio ? '<dt>Introduction / bio</dt><dd>' + escapeHtml(speech.introBio) + '</dd>' : '') +
        (speech.audienceGoals ? '<dt>Audience connection goals</dt><dd>' + escapeHtml(speech.audienceGoals) + '</dd>' : '') +
        (meeting ? '<dt>Scheduled meeting</dt><dd>' + escapeHtml(meeting) + '</dd>' : '<dt>Schedule</dt><dd>Unscheduled</dd>') +
      '</dl>' +
      '<div class="row-actions">' +
        '<button type="button" class="btn" data-edit-speech="' + escapeHtml(speech.id) + '">Edit</button>' +
        '<button type="button" class="btn" data-duplicate-speech="' + escapeHtml(speech.id) + '">Duplicate</button>' +
        '<button type="button" class="btn btn-danger-ghost" data-delete-speech="' + escapeHtml(speech.id) + '">Delete</button>' +
      '</div>' +
    '</article>';
  }
  document.getElementById('panel-speeches').innerHTML =
    '<div class="stack">' +
      '<div class="section-head"><div><h2>Speeches</h2><p class="lede">Draft titles, introductions, timing targets, and audience goals. Duplicate a speech to reuse it for a later meeting.</p></div>' +
      '<button type="button" class="btn btn-primary" data-new-speech>New speech</button></div>' +
      '<div class="speech-grid">' + (cards || '<div class="empty">No speeches yet.</div>') + '</div>' +
    '</div>';
}

function describeMeeting(id) {
  const parts = String(id).split(':');
  const club = clubById(parts[0]);
  const date = parts.slice(1).join(':');
  if (!club || !date) return id;
  return club.name + ' · ' + formatLongDate(date);
}

function renderPractice() {
  if (!practiceSpeechId || !speechById(practiceSpeechId)) {
    practiceSpeechId = state.speeches[0] ? state.speeches[0].id : '';
    if (practiceSpeechId && (!timer.presetId || timer.presetId.indexOf('speech:') === 0)) {
      applySpeechBands(practiceSpeechId, { silent: true });
    }
  }
  let logs = '';
  const records = state.practices.slice().sort(function (a, b) {
    return (a.date + a.createdAt) < (b.date + b.createdAt) ? 1 : -1;
  });
  for (let i = 0; i < records.length; i += 1) {
    const log = records[i];
    const speech = speechById(log.speechId);
    logs += '<article class="card">' +
      '<h3>' + escapeHtml(speech ? speech.title : 'Untitled speech') + '</h3>' +
      '<p class="meta">' + escapeHtml(log.date ? formatLongDate(log.date) : 'No date') + ' · ' + escapeHtml(formatDuration(log.durationSeconds)) + ' · ' + (log.usedNotes ? 'Used notes' : 'No notes') + '</p>' +
      (log.selfNotes ? '<p>' + escapeHtml(log.selfNotes) + '</p>' : '') +
      '<div class="row-actions"><button type="button" class="btn btn-danger-ghost" data-delete-practice="' + escapeHtml(log.id) + '">Delete log</button></div>' +
    '</article>';
  }
  const speechOptions = optionList(state.speeches.map(function (speech) {
    return { id: speech.id, label: speech.title };
  }), practiceSpeechId, state.speeches.length ? '' : 'No speeches yet');
  document.getElementById('panel-practice').innerHTML =
    '<div class="stack">' +
      '<div class="section-head"><div><h2>Practice</h2><p class="lede">Rehearse against a speech’s timing target, then log whether you used notes.</p></div></div>' +
      '<div class="card stack">' +
        '<label>Speech<select data-practice-speech' + (state.speeches.length ? '' : ' disabled') + '>' + speechOptions + '</select></label>' +
        timerPanelHtml('practice') +
      '</div>' +
      '<h3>No-notes practice log</h3>' +
      '<div class="list">' + (logs || '<div class="empty">No practice logs yet. Run the timer, then save a log.</div>') + '</div>' +
    '</div>';
  updateTimerUI();
}

function renderFeedback() {
  let cards = '';
  const records = state.feedback.slice().sort(function (a, b) {
    return (a.date + a.createdAt) < (b.date + b.createdAt) ? 1 : -1;
  });
  for (let i = 0; i < records.length; i += 1) {
    const entry = records[i];
    const speech = speechById(entry.speechId);
    let follow = '';
    for (let j = 0; j < entry.followUps.length; j += 1) {
      const item = entry.followUps[j];
      follow += '<label class="checkbox' + (item.done ? ' done' : '') + '"><input type="checkbox" data-toggle-followup="' + escapeHtml(entry.id) + ':' + escapeHtml(item.id) + '"' + (item.done ? ' checked' : '') + '> <span class="item-text">' + escapeHtml(item.text) + '</span></label>';
    }
    cards += '<article class="card">' +
      '<p class="meta">' + escapeHtml(entry.date ? formatLongDate(entry.date) : 'No date') + (speech ? ' · ' + escapeHtml(speech.title) : '') + (entry.source ? ' · From ' + escapeHtml(entry.source) : '') + '</p>' +
      (entry.comments ? '<p>' + escapeHtml(entry.comments) + '</p>' : '') +
      (follow ? '<div class="follow-up"><h3>Follow-up</h3>' + follow + '</div>' : '') +
      '<div class="row-actions">' +
        '<button type="button" class="btn" data-edit-feedback="' + escapeHtml(entry.id) + '">Edit</button>' +
        '<button type="button" class="btn btn-danger-ghost" data-delete-feedback="' + escapeHtml(entry.id) + '">Delete</button>' +
      '</div>' +
    '</article>';
  }
  document.getElementById('panel-feedback').innerHTML =
    '<div class="stack">' +
      '<div class="section-head"><div><h2>Feedback history</h2><p class="lede">Keep evaluator comments and turn them into follow-up actions you can check off.</p></div>' +
      '<button type="button" class="btn btn-primary" data-new-feedback>New feedback</button></div>' +
      '<div class="list">' + (cards || '<div class="empty">No feedback yet.</div>') + '</div>' +
    '</div>';
}

function renderEvents() {
  let cards = '';
  const records = state.events.slice().sort(function (a, b) {
    return (a.date || '') < (b.date || '') ? 1 : (a.date || '') > (b.date || '') ? -1 : 0;
  });
  for (let i = 0; i < records.length; i += 1) {
    const eventItem = records[i];
    cards += '<article class="card">' +
      '<div class="badge-row"><span class="badge">' + (eventItem.type === 'open-house' ? 'Open house' : 'Special event') + '</span></div>' +
      '<h3>' + escapeHtml(eventItem.title) + '</h3>' +
      '<p class="meta">' + (eventItem.date ? escapeHtml(formatLongDate(eventItem.date)) : 'Date not set') + '</p>' +
      eventSection('Run of show', eventItem.runOfShow.map(function (row) {
        return [row.time, row.item, row.who].filter(Boolean).join(' · ');
      })) +
      eventSection('Intros', eventItem.intros.map(function (row) {
        return (row.person ? row.person + ': ' : '') + row.text;
      })) +
      eventChecklist(eventItem) +
      eventSection('Roles', eventItem.roles.map(function (row) {
        return [row.role, row.person].filter(Boolean).join(' — ');
      })) +
      '<div class="row-actions">' +
        '<button type="button" class="btn" data-edit-event="' + escapeHtml(eventItem.id) + '">Edit</button>' +
        '<button type="button" class="btn btn-danger-ghost" data-delete-event="' + escapeHtml(eventItem.id) + '">Delete</button>' +
      '</div>' +
    '</article>';
  }
  document.getElementById('panel-events').innerHTML =
    '<div class="stack">' +
      '<div class="section-head"><div><h2>Special events and open house</h2><p class="lede">Plan a run of show, introductions, setup checklist, and roles for a one-off meeting.</p></div>' +
      '<button type="button" class="btn btn-primary" data-new-event>New event</button></div>' +
      '<div class="list">' + (cards || '<div class="empty">No special events yet.</div>') + '</div>' +
    '</div>';
}

function eventSection(title, lines) {
  const usable = lines.filter(Boolean);
  if (!usable.length) return '';
  let html = '<div class="event-block"><h3>' + escapeHtml(title) + '</h3><div class="sublist">';
  for (let i = 0; i < usable.length; i += 1) {
    html += '<div class="subitem"><span class="item-text">' + escapeHtml(usable[i]) + '</span></div>';
  }
  return html + '</div></div>';
}

function eventChecklist(eventItem) {
  if (!eventItem.setupChecklist.length) return '';
  let html = '<div class="event-block"><h3>Setup checklist</h3><div class="follow-up">';
  for (let i = 0; i < eventItem.setupChecklist.length; i += 1) {
    const item = eventItem.setupChecklist[i];
    html += '<label class="checkbox' + (item.done ? ' done' : '') + '"><input type="checkbox" data-toggle-setup="' + escapeHtml(eventItem.id) + ':' + escapeHtml(item.id) + '"' + (item.done ? ' checked' : '') + '> <span class="item-text">' + escapeHtml(item.text) + '</span></label>';
  }
  return html + '</div></div>';
}

function elapsedSeconds() {
  const extra = timer.running ? (Date.now() - timer.startedAt) / 1000 : 0;
  return timer.accumulated + extra;
}

function startTimer() {
  if (timer.running) return;
  timer.running = true;
  timer.startedAt = Date.now();
  tickTimer();
  syncTimerButtons();
}

function pauseTimer() {
  if (!timer.running) return;
  timer.accumulated += (Date.now() - timer.startedAt) / 1000;
  timer.running = false;
  timer.startedAt = null;
  if (timer.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(timer.raf);
  timer.raf = null;
  updateTimerUI();
  syncTimerButtons();
}

function resetTimer() {
  timer.running = false;
  timer.startedAt = null;
  timer.accumulated = 0;
  timer.lastCue = 'clear';
  if (timer.raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(timer.raf);
  timer.raf = null;
  updateTimerUI();
  syncTimerButtons();
}

function tickTimer() {
  updateTimerUI();
  if (!timer.running) return;
  timer.raf = requestAnimationFrame(tickTimer);
}

function syncTimerButtons() {
  const buttons = document.querySelectorAll('[data-timer-start]');
  for (let i = 0; i < buttons.length; i += 1) {
    buttons[i].textContent = timer.running ? 'Pause' : 'Start';
  }
}

function updateTimerUI() {
  const elapsed = elapsedSeconds();
  const cue = cueFromElapsed(elapsed, timer.bands);
  const boards = document.querySelectorAll('[data-timer-board]');
  for (let i = 0; i < boards.length; i += 1) {
    const board = boards[i];
    board.classList.remove('cue-green', 'cue-yellow', 'cue-red');
    if (cue !== 'clear') board.classList.add('cue-' + cue);
    const face = board.querySelector('[data-timer-face]');
    const cueEl = board.querySelector('[data-timer-cue]');
    const bands = board.querySelector('[data-timer-bands]');
    if (face) face.textContent = formatDuration(elapsed);
    if (cueEl) cueEl.textContent = cueLabel(cue);
    if (bands) {
      bands.textContent = 'Green ' + formatDuration(timer.bands.green) +
        ' · Yellow ' + formatDuration(timer.bands.yellow) +
        ' · Red ' + formatDuration(timer.bands.red);
    }
  }
  timer.lastCue = cue;
  syncTimerButtons();
}

function applyPreset(presetId, options) {
  const opts = options || {};
  timer.presetId = presetId;
  if (presetId.indexOf('speech:') === 0) {
    applySpeechBands(presetId.slice(7), opts);
    return;
  }
  if (presetId === 'custom') {
    if (!opts.silent) updateCustomBandVisibility();
    return;
  }
  const preset = TIMER_PRESETS.find(function (item) { return item.id === presetId; });
  if (preset) timer.bands = { green: preset.green, yellow: preset.yellow, red: preset.red };
  if (!opts.silent) {
    updateCustomBandVisibility();
    updateTimerUI();
  }
}

function applySpeechBands(speechId, options) {
  const speech = speechById(speechId);
  if (!speech) return;
  timer.presetId = 'speech:' + speech.id;
  timer.bands = timingBands(speech.timingMin, speech.timingMax);
  if (!(options && options.silent)) {
    updateCustomBandVisibility();
    updateTimerUI();
  }
}

function updateCustomBandVisibility() {
  const wrap = document.querySelector('[data-custom-bands]');
  if (wrap) wrap.hidden = timer.presetId !== 'custom';
}

function setCustomBand(name, minutes) {
  const seconds = Math.round(Math.max(0, Number(minutes) || 0) * 60);
  timer.bands[name] = seconds;
  timer.presetId = 'custom';
  updateTimerUI();
}

function openMeetingEditor(id) {
  const upcoming = getMergedOccurrences(new Date(), 16);
  const occ = upcoming.find(function (item) { return item.id === id; });
  if (!occ) return;
  const matched = state.roles.find(function (role) { return role.name === occ.role; });
  const roleOptions = optionList(state.roles, matched ? matched.id : '', 'No role set');
  openDialog({
    title: 'Edit meeting details',
    confirmLabel: 'Save details',
    render: function () {
      return '<p class="meta u-mb-08">' + escapeHtml(occ.club.name) + ' · ' + escapeHtml(formatLongDate(occ.date)) + ' · ' + escapeHtml(formatTimeRange(occ.start, occ.end)) + '</p>' +
        '<form id="dialog-form" class="form-grid">' +
          '<label>Status<select name="status">' + optionList(MEETING_STATUSES, occ.status) + '</select></label>' +
          '<label>Role<select name="roleId">' + roleOptions + '</select></label>' +
          '<label>Or write in a role<input type="text" name="roleWriteIn" value="' + (matched ? '' : escapeHtml(occ.role)) + '" maxlength="80"></label>' +
          '<label>Notes<textarea name="notes" rows="4">' + escapeHtml(occ.notes) + '</textarea></label>' +
          '<label class="checkbox"><input type="checkbox" name="uncertain"' + (occ.uncertain ? ' checked' : '') + '> Some details are uncertain</label>' +
        '</form>';
    },
    onConfirm: function (root) {
      const form = root.querySelector('#dialog-form');
      const writeIn = str(form.roleWriteIn.value);
      let role = writeIn;
      if (!role && form.roleId.value) {
        const selected = state.roles.find(function (item) { return item.id === form.roleId.value; });
        role = selected ? selected.name : '';
      }
      state.meetings[id] = {
        notes: str(form.notes.value),
        role: role,
        status: form.status.value,
        uncertain: form.uncertain.checked
      };
      saveState();
      renderCurrent();
    }
  });
}

function openSpeechEditor(speech) {
  const isNew = !speech;
  const draft = speech ? Object.assign({}, speech) : {
    id: uid(),
    title: '',
    projectPathway: '',
    introBio: '',
    timingMin: 5,
    timingMax: 7,
    audienceGoals: '',
    status: 'draft',
    meetingId: '',
    createdAt: new Date().toISOString()
  };
  const meetings = getMergedOccurrences(new Date(), 8).map(function (occ) {
    return { id: occ.id, label: occ.club.name + ' · ' + formatLongDate(occ.date) };
  });
  openDialog({
    title: isNew ? 'New speech' : 'Edit speech',
    confirmLabel: isNew ? 'Add speech' : 'Save speech',
    render: function () {
      return '<form id="dialog-form" class="form-grid">' +
        '<label>Title<input type="text" name="title" required maxlength="160" value="' + escapeHtml(draft.title) + '"></label>' +
        '<label>Project / pathway<input type="text" name="projectPathway" maxlength="160" value="' + escapeHtml(draft.projectPathway) + '"></label>' +
        '<div class="form-grid two">' +
          '<label>Timing minimum (minutes)<input type="number" name="timingMin" min="0" max="60" step="0.5" required value="' + escapeHtml(String(draft.timingMin)) + '"></label>' +
          '<label>Timing maximum (minutes)<input type="number" name="timingMax" min="0" max="60" step="0.5" required value="' + escapeHtml(String(draft.timingMax)) + '"></label>' +
        '</div>' +
        '<label>Status<select name="status">' + optionList(SPEECH_STATUSES, draft.status) + '</select></label>' +
        '<label>Scheduled meeting<select name="meetingId">' + optionList(meetings, draft.meetingId, 'Unscheduled') + '</select></label>' +
        '<label>Introduction / bio<textarea name="introBio" rows="5">' + escapeHtml(draft.introBio) + '</textarea></label>' +
        '<label>Audience connection goals<textarea name="audienceGoals" rows="4">' + escapeHtml(draft.audienceGoals) + '</textarea></label>' +
      '</form>';
    },
    onConfirm: function (root) {
      const form = root.querySelector('#dialog-form');
      if (!form.reportValidity()) return false;
      const timingMin = num(form.timingMin.value, 5);
      const timingMax = num(form.timingMax.value, 7);
      if (timingMax < timingMin) {
        form.timingMax.setCustomValidity('Maximum must be at least the minimum.');
        form.timingMax.reportValidity();
        form.timingMax.setCustomValidity('');
        return false;
      }
      const next = {
        id: draft.id,
        title: str(form.title.value),
        projectPathway: str(form.projectPathway.value),
        introBio: str(form.introBio.value),
        timingMin: timingMin,
        timingMax: timingMax,
        audienceGoals: str(form.audienceGoals.value),
        status: form.status.value,
        meetingId: str(form.meetingId.value),
        createdAt: draft.createdAt
      };
      const index = state.speeches.findIndex(function (item) { return item.id === draft.id; });
      if (index >= 0) state.speeches[index] = next;
      else state.speeches.push(next);
      saveState();
      renderCurrent();
    }
  });
}

function duplicateSpeech(id) {
  const speech = speechById(id);
  if (!speech) return;
  const copy = Object.assign({}, speech, {
    id: uid(),
    title: speech.title.indexOf('Copy of ') === 0 ? speech.title : 'Copy of ' + speech.title,
    status: 'draft',
    meetingId: '',
    createdAt: new Date().toISOString()
  });
  state.speeches.push(copy);
  saveState();
  renderCurrent();
}

function parseDurationInput(value) {
  const raw = str(value);
  if (/^\d+:\d{1,2}$/.test(raw)) {
    const bits = raw.split(':').map(Number);
    return bits[0] * 60 + bits[1];
  }
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw));
  return null;
}

function openPracticeLogEditor() {
  const speech = speechById(practiceSpeechId);
  if (!speech) {
    informDialog('Add a speech first, then save a practice log.');
    return;
  }
  if (timer.running) pauseTimer();
  const duration = Math.round(elapsedSeconds());
  openDialog({
    title: 'Save practice log',
    confirmLabel: 'Save log',
    render: function () {
      return '<form id="dialog-form" class="form-grid">' +
        '<p class="meta">Speech: ' + escapeHtml(speech.title) + '</p>' +
        '<label>Date<input type="date" name="date" required value="' + escapeHtml(ymdInZone(new Date())) + '"></label>' +
        '<label>Duration (minutes:seconds, or total seconds)<input type="text" name="duration" required value="' + escapeHtml(formatDuration(duration)) + '"></label>' +
        '<label class="checkbox"><input type="checkbox" name="usedNotes"> Used notes during this practice</label>' +
        '<label>Self-notes<textarea name="selfNotes" rows="4" placeholder="What worked, what to try next"></textarea></label>' +
      '</form>';
    },
    onConfirm: function (root) {
      const form = root.querySelector('#dialog-form');
      if (!form.reportValidity()) return false;
      const seconds = parseDurationInput(form.duration.value);
      if (seconds == null) {
        form.duration.setCustomValidity('Enter time as m:ss or as a number of seconds.');
        form.duration.reportValidity();
        form.duration.setCustomValidity('');
        return false;
      }
      state.practices.push({
        id: uid(),
        speechId: speech.id,
        date: form.date.value,
        durationSeconds: seconds,
        usedNotes: form.usedNotes.checked,
        selfNotes: str(form.selfNotes.value),
        createdAt: new Date().toISOString()
      });
      saveState();
      renderCurrent();
    }
  });
}

function openFeedbackEditor(entry) {
  const isNew = !entry;
  const draft = entry ? JSON.parse(JSON.stringify(entry)) : {
    id: uid(),
    date: ymdInZone(new Date()),
    speechId: '',
    source: '',
    comments: '',
    followUps: [],
    createdAt: new Date().toISOString()
  };
  function body() {
    let follow = '';
    for (let i = 0; i < draft.followUps.length; i += 1) {
      const item = draft.followUps[i];
      follow += '<div class="subitem"><label>Action<input type="text" data-follow-text="' + escapeHtml(item.id) + '" value="' + escapeHtml(item.text) + '"></label>' +
        '<button type="button" class="icon-btn" data-remove-follow="' + escapeHtml(item.id) + '">Remove</button></div>';
    }
    return '<form id="dialog-form" class="form-grid">' +
      '<label>Date<input type="date" name="date" required value="' + escapeHtml(draft.date) + '"></label>' +
      '<label>Related speech<select name="speechId">' + optionList(state.speeches.map(function (speech) { return { id: speech.id, label: speech.title }; }), draft.speechId, 'None') + '</select></label>' +
      '<label>From<input type="text" name="source" maxlength="120" value="' + escapeHtml(draft.source) + '" placeholder="Evaluator or source"></label>' +
      '<label>Comments<textarea name="comments" rows="5">' + escapeHtml(draft.comments) + '</textarea></label>' +
      '<div><div class="section-head"><h3>Follow-up actions</h3><button type="button" class="btn" data-add-follow>Add action</button></div>' +
      '<div class="sublist" data-follow-list>' + (follow || '<p class="muted">No follow-up actions yet.</p>') + '</div></div>' +
    '</form>';
  }
  function syncFeedbackDraft() {
    const form = document.querySelector('#dialog-form');
    if (!form) return;
    draft.date = form.date.value;
    draft.speechId = form.speechId.value;
    draft.source = form.source.value;
    draft.comments = form.comments.value;
    const inputs = form.querySelectorAll('[data-follow-text]');
    for (let i = 0; i < inputs.length; i += 1) {
      const id = inputs[i].getAttribute('data-follow-text');
      const item = draft.followUps.find(function (row) { return row.id === id; });
      if (item) item.text = inputs[i].value;
    }
  }
  openDialog({
    title: isNew ? 'New feedback' : 'Edit feedback',
    confirmLabel: isNew ? 'Add feedback' : 'Save feedback',
    render: body,
    onClick: function (event) {
      if (event.target.closest('[data-add-follow]')) {
        syncFeedbackDraft();
        draft.followUps.push({ id: uid(), text: '', done: false });
        dialogCtl.paint();
      }
      const remove = event.target.closest('[data-remove-follow]');
      if (remove) {
        syncFeedbackDraft();
        const id = remove.getAttribute('data-remove-follow');
        draft.followUps = draft.followUps.filter(function (item) { return item.id !== id; });
        dialogCtl.paint();
      }
    },
    onConfirm: function (root) {
      const form = root.querySelector('#dialog-form');
      if (!form.reportValidity()) return false;
      syncFeedbackDraft();
      draft.date = form.date.value;
      draft.speechId = str(form.speechId.value);
      draft.source = str(form.source.value);
      draft.comments = str(form.comments.value);
      draft.followUps = draft.followUps.filter(function (item) { return str(item.text); }).map(function (item) {
        return { id: item.id, text: str(item.text), done: !!item.done };
      });
      const index = state.feedback.findIndex(function (item) { return item.id === draft.id; });
      if (index >= 0) state.feedback[index] = draft;
      else state.feedback.push(draft);
      saveState();
      renderCurrent();
    }
  });
}

function openEventEditor(eventItem) {
  const isNew = !eventItem;
  const draft = eventItem ? JSON.parse(JSON.stringify(eventItem)) : {
    id: uid(),
    title: '',
    date: '',
    type: 'open-house',
    runOfShow: [{ id: uid(), time: '', item: '', who: '' }],
    intros: [{ id: uid(), person: '', text: '' }],
    setupChecklist: [{ id: uid(), text: '', done: false }],
    roles: [{ id: uid(), role: '', person: '' }],
    createdAt: new Date().toISOString()
  };

  function rowsHtml(list, kind) {
    let html = '';
    for (let i = 0; i < list.length; i += 1) {
      const row = list[i];
      if (kind === 'run') {
        html += '<div class="subitem grid-3a">' +
          '<input type="text" data-ev="run.time.' + escapeHtml(row.id) + '" value="' + escapeHtml(row.time) + '" placeholder="Time">' +
          '<input type="text" data-ev="run.item.' + escapeHtml(row.id) + '" value="' + escapeHtml(row.item) + '" placeholder="Item">' +
          '<input type="text" data-ev="run.who.' + escapeHtml(row.id) + '" value="' + escapeHtml(row.who) + '" placeholder="Who">' +
          '<button type="button" class="icon-btn" data-remove-row="run:' + escapeHtml(row.id) + '">Remove</button></div>';
      } else if (kind === 'intro') {
        html += '<div class="subitem grid-12a">' +
          '<input type="text" data-ev="intro.person.' + escapeHtml(row.id) + '" value="' + escapeHtml(row.person) + '" placeholder="Name or role">' +
          '<input type="text" data-ev="intro.text.' + escapeHtml(row.id) + '" value="' + escapeHtml(row.text) + '" placeholder="Introduction">' +
          '<button type="button" class="icon-btn" data-remove-row="intro:' + escapeHtml(row.id) + '">Remove</button></div>';
      } else if (kind === 'setup') {
        html += '<div class="subitem">' +
          '<input type="text" data-ev="setup.text.' + escapeHtml(row.id) + '" value="' + escapeHtml(row.text) + '" placeholder="Checklist item">' +
          '<button type="button" class="icon-btn" data-remove-row="setup:' + escapeHtml(row.id) + '">Remove</button></div>';
      } else {
        html += '<div class="subitem grid-2a">' +
          '<input type="text" data-ev="role.role.' + escapeHtml(row.id) + '" value="' + escapeHtml(row.role) + '" placeholder="Role">' +
          '<input type="text" data-ev="role.person.' + escapeHtml(row.id) + '" value="' + escapeHtml(row.person) + '" placeholder="Assigned to">' +
          '<button type="button" class="icon-btn" data-remove-row="role:' + escapeHtml(row.id) + '">Remove</button></div>';
      }
    }
    return html || '<p class="muted">No rows yet.</p>';
  }

  function body() {
    return '<form id="dialog-form" class="form-grid">' +
      '<label>Title<input type="text" name="title" required maxlength="160" value="' + escapeHtml(draft.title) + '"></label>' +
      '<div class="form-grid two">' +
        '<label>Date<input type="date" name="date" value="' + escapeHtml(draft.date) + '"></label>' +
        '<label>Type<select name="type">' +
          '<option value="open-house"' + (draft.type === 'open-house' ? ' selected' : '') + '>Open house</option>' +
          '<option value="special"' + (draft.type === 'special' ? ' selected' : '') + '>Special event</option>' +
        '</select></label>' +
      '</div>' +
      '<div class="event-block"><div class="section-head"><h3>Run of show</h3><button type="button" class="btn" data-add-row="run">Add item</button></div><div class="sublist">' + rowsHtml(draft.runOfShow, 'run') + '</div></div>' +
      '<div class="event-block"><div class="section-head"><h3>Intros</h3><button type="button" class="btn" data-add-row="intro">Add intro</button></div><div class="sublist">' + rowsHtml(draft.intros, 'intro') + '</div></div>' +
      '<div class="event-block"><div class="section-head"><h3>Setup checklist</h3><button type="button" class="btn" data-add-row="setup">Add item</button></div><div class="sublist">' + rowsHtml(draft.setupChecklist, 'setup') + '</div></div>' +
      '<div class="event-block"><div class="section-head"><h3>Roles</h3><button type="button" class="btn" data-add-row="role">Add role</button></div><div class="sublist">' + rowsHtml(draft.roles, 'role') + '</div></div>' +
    '</form>';
  }

  function syncDraft() {
    const form = document.querySelector('#dialog-form');
    if (!form) return;
    draft.title = form.title.value;
    draft.date = form.date.value;
    draft.type = form.type.value;
    const inputs = form.querySelectorAll('[data-ev]');
    for (let i = 0; i < inputs.length; i += 1) {
      const bits = inputs[i].getAttribute('data-ev').split('.');
      const group = bits[0];
      const field = bits[1];
      const id = bits.slice(2).join('.');
      let list = null;
      if (group === 'run') list = draft.runOfShow;
      else if (group === 'intro') list = draft.intros;
      else if (group === 'setup') list = draft.setupChecklist;
      else if (group === 'role') list = draft.roles;
      if (!list) continue;
      const row = list.find(function (item) { return item.id === id; });
      if (row) row[field] = inputs[i].value;
    }
  }

  openDialog({
    title: isNew ? 'New event' : 'Edit event',
    confirmLabel: isNew ? 'Add event' : 'Save event',
    render: body,
    onClick: function (event) {
      const add = event.target.closest('[data-add-row]');
      const remove = event.target.closest('[data-remove-row]');
      if (!add && !remove) return;
      syncDraft();
      if (add) {
        const kind = add.getAttribute('data-add-row');
        if (kind === 'run') draft.runOfShow.push({ id: uid(), time: '', item: '', who: '' });
        if (kind === 'intro') draft.intros.push({ id: uid(), person: '', text: '' });
        if (kind === 'setup') draft.setupChecklist.push({ id: uid(), text: '', done: false });
        if (kind === 'role') draft.roles.push({ id: uid(), role: '', person: '' });
      }
      if (remove) {
        const bits = remove.getAttribute('data-remove-row').split(':');
        const kind = bits[0];
        const id = bits.slice(1).join(':');
        if (kind === 'run') draft.runOfShow = draft.runOfShow.filter(function (row) { return row.id !== id; });
        if (kind === 'intro') draft.intros = draft.intros.filter(function (row) { return row.id !== id; });
        if (kind === 'setup') draft.setupChecklist = draft.setupChecklist.filter(function (row) { return row.id !== id; });
        if (kind === 'role') draft.roles = draft.roles.filter(function (row) { return row.id !== id; });
      }
      dialogCtl.paint();
    },
    onConfirm: function (root) {
      const form = root.querySelector('#dialog-form');
      if (!form.reportValidity()) return false;
      syncDraft();
      draft.title = str(form.title.value);
      draft.date = str(form.date.value);
      draft.type = form.type.value === 'open-house' ? 'open-house' : 'special';
      draft.runOfShow = draft.runOfShow.filter(function (row) { return str(row.time) || str(row.item) || str(row.who); });
      draft.intros = draft.intros.filter(function (row) { return str(row.person) || str(row.text); });
      draft.setupChecklist = draft.setupChecklist.filter(function (row) { return str(row.text); }).map(function (row) {
        const prev = ((eventItem && eventItem.setupChecklist) || []).find(function (item) { return item.id === row.id; });
        return { id: row.id, text: str(row.text), done: prev ? !!prev.done : !!row.done };
      });
      draft.roles = draft.roles.filter(function (row) { return str(row.role) || str(row.person); });
      const index = state.events.findIndex(function (item) { return item.id === draft.id; });
      if (index >= 0) state.events[index] = draft;
      else state.events.push(draft);
      saveState();
      renderCurrent();
    }
  });
}

function onBodyClick(event) {
  const filter = event.target.closest('[data-meeting-filter]');
  if (filter) {
    meetingFilter = filter.getAttribute('data-meeting-filter');
    renderMeetings();
    return;
  }
  const editMeeting = event.target.closest('[data-edit-meeting]');
  if (editMeeting) return openMeetingEditor(editMeeting.getAttribute('data-edit-meeting'));
  const deleteRole = event.target.closest('[data-delete-role]');
  if (deleteRole) return deleteRoleById(deleteRole.getAttribute('data-delete-role'));
  if (event.target.closest('[data-timer-start]')) {
    if (timer.running) pauseTimer();
    else startTimer();
    return;
  }
  if (event.target.closest('[data-timer-reset]')) return resetTimer();
  if (event.target.closest('[data-save-practice]')) return openPracticeLogEditor();
  if (event.target.closest('[data-new-speech]')) return openSpeechEditor(null);
  const editSpeech = event.target.closest('[data-edit-speech]');
  if (editSpeech) return openSpeechEditor(speechById(editSpeech.getAttribute('data-edit-speech')));
  const dupSpeech = event.target.closest('[data-duplicate-speech]');
  if (dupSpeech) return duplicateSpeech(dupSpeech.getAttribute('data-duplicate-speech'));
  const deleteSpeech = event.target.closest('[data-delete-speech]');
  if (deleteSpeech) return deleteSpeechById(deleteSpeech.getAttribute('data-delete-speech'));
  const deletePractice = event.target.closest('[data-delete-practice]');
  if (deletePractice) return deletePracticeById(deletePractice.getAttribute('data-delete-practice'));
  if (event.target.closest('[data-new-feedback]')) return openFeedbackEditor(null);
  const editFeedback = event.target.closest('[data-edit-feedback]');
  if (editFeedback) return openFeedbackEditor(state.feedback.find(function (item) { return item.id === editFeedback.getAttribute('data-edit-feedback'); }));
  const deleteFeedback = event.target.closest('[data-delete-feedback]');
  if (deleteFeedback) return deleteFeedbackById(deleteFeedback.getAttribute('data-delete-feedback'));
  if (event.target.closest('[data-new-event]')) return openEventEditor(null);
  const editEvent = event.target.closest('[data-edit-event]');
  if (editEvent) return openEventEditor(state.events.find(function (item) { return item.id === editEvent.getAttribute('data-edit-event'); }));
  const deleteEvent = event.target.closest('[data-delete-event]');
  if (deleteEvent) return deleteEventById(deleteEvent.getAttribute('data-delete-event'));
}

function onBodyChange(event) {
  const roleName = event.target.closest('[data-role-name]');
  if (roleName) {
    const role = state.roles.find(function (item) { return item.id === roleName.getAttribute('data-role-name'); });
    if (role && str(roleName.value)) {
      role.name = str(roleName.value);
      saveState();
    }
    return;
  }
  const preset = event.target.closest('[data-timer-preset]');
  if (preset) {
    applyPreset(preset.value);
    return;
  }
  const band = event.target.closest('[data-band]');
  if (band) {
    setCustomBand(band.getAttribute('data-band'), band.value);
    const select = document.querySelector('[data-timer-preset]');
    if (select) select.value = 'custom';
    updateCustomBandVisibility();
    return;
  }
  const practiceSpeech = event.target.closest('[data-practice-speech]');
  if (practiceSpeech) {
    practiceSpeechId = practiceSpeech.value;
    applySpeechBands(practiceSpeechId);
    if (elapsedSeconds() > 0 || timer.running) resetTimer();
    return;
  }
  const follow = event.target.closest('[data-toggle-followup]');
  if (follow) {
    const bits = follow.getAttribute('data-toggle-followup').split(':');
    const entry = state.feedback.find(function (item) { return item.id === bits[0]; });
    if (!entry) return;
    const item = entry.followUps.find(function (row) { return row.id === bits.slice(1).join(':'); });
    if (item) {
      item.done = follow.checked;
      saveState();
      renderCurrent();
    }
    return;
  }
  const setup = event.target.closest('[data-toggle-setup]');
  if (setup) {
    const bits = setup.getAttribute('data-toggle-setup').split(':');
    const eventItem = state.events.find(function (item) { return item.id === bits[0]; });
    if (!eventItem) return;
    const item = eventItem.setupChecklist.find(function (row) { return row.id === bits.slice(1).join(':'); });
    if (item) {
      item.done = setup.checked;
      saveState();
      renderCurrent();
    }
  }
}

function onBodySubmit(event) {
  const form = event.target.closest('[data-form="add-role"]');
  if (!form) return;
  event.preventDefault();
  const input = form.querySelector('[name="name"]');
  const name = str(input.value);
  if (!name) return;
  state.roles.push({ id: uid(), name: name });
  saveState();
  renderCurrent();
}

async function deleteRoleById(id) {
  const role = state.roles.find(function (item) { return item.id === id; });
  if (!role) return;
  const ok = await confirmDialog('Remove “' + role.name + '” from the role list? Meeting assignments that already use this name will be kept.', {
    title: 'Remove role',
    confirmLabel: 'Remove role',
    danger: true
  });
  if (!ok) return;
  state.roles = state.roles.filter(function (item) { return item.id !== id; });
  saveState();
  renderCurrent();
}

async function deleteSpeechById(id) {
  const speech = speechById(id);
  if (!speech) return;
  const ok = await confirmDialog('Delete the speech “' + speech.title + '”? Practice logs linked to it will remain, but the title will no longer resolve.', {
    title: 'Delete speech',
    confirmLabel: 'Delete speech',
    danger: true
  });
  if (!ok) return;
  state.speeches = state.speeches.filter(function (item) { return item.id !== id; });
  saveState();
  renderCurrent();
}

async function deletePracticeById(id) {
  const ok = await confirmDialog('Delete this practice log?', { title: 'Delete log', confirmLabel: 'Delete log', danger: true });
  if (!ok) return;
  state.practices = state.practices.filter(function (item) { return item.id !== id; });
  saveState();
  renderCurrent();
}

async function deleteFeedbackById(id) {
  const ok = await confirmDialog('Delete this feedback entry and its follow-up actions?', { title: 'Delete feedback', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  state.feedback = state.feedback.filter(function (item) { return item.id !== id; });
  saveState();
  renderCurrent();
}

async function deleteEventById(id) {
  const ok = await confirmDialog('Delete this event plan?', { title: 'Delete event', confirmLabel: 'Delete event', danger: true });
  if (!ok) return;
  state.events = state.events.filter(function (item) { return item.id !== id; });
  saveState();
  renderCurrent();
}

function exportData() {
  const payload = buildExportPayload(state);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'toastmasters-workspace-' + ymdInZone(new Date()) + '.json';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(function () { URL.revokeObjectURL(link.href); }, 1000);
}

async function onImportFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  let text;
  try {
    text = await file.text();
  } catch (err) {
    await informDialog('The file could not be read.');
    return;
  }
  const result = parseAndValidateImport(text);
  if (!result.ok) {
    await informDialog(result.error, 'Import failed');
    return;
  }
  const summary = result.summary;
  const ok = await confirmDialog(
    'Replace all workspace data in this browser with this backup? It contains ' +
      summary.speeches + ' speech(es), ' +
      summary.meetings + ' meeting note(s), ' +
      summary.practices + ' practice log(s), ' +
      summary.feedback + ' feedback entr' + (summary.feedback === 1 ? 'y' : 'ies') + ', and ' +
      summary.events + ' event(s). This cannot be undone unless you already have an export.',
    { title: 'Import backup', confirmLabel: 'Replace data', danger: true }
  );
  if (!ok) return;
  state = result.state;
  saveState();
  renderCurrent();
}

async function resetData() {
  const ok = await confirmDialog(
    'This will erase meeting notes, speeches, practice logs, feedback, and events stored in this browser, and restore the default draft speech. This cannot be undone unless you already exported a backup.',
    { title: 'Reset workspace', confirmLabel: 'Reset workspace', danger: true }
  );
  if (!ok) return;
  state = defaultState();
  saveState();
  practiceSpeechId = state.speeches[0] ? state.speeches[0].id : '';
  resetTimer();
  applyPreset('s57', { silent: true });
  renderCurrent();
}

function openDialog(options) {
  const root = document.getElementById('dialog-root');
  const previouslyFocused = document.activeElement;
  dialogCtl = {
    options: options,
    previouslyFocused: previouslyFocused,
    paint: paint
  };
  function paint() {
    root.innerHTML =
      '<div class="dialog-backdrop" data-dialog-backdrop>' +
        '<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" tabindex="-1">' +
          '<h2 id="dialog-title">' + escapeHtml(options.title) + '</h2>' +
          '<div class="dialog-body">' + options.render() + '</div>' +
          '<div class="dialog-actions">' +
            (options.hideCancel ? '' : '<button type="button" class="btn" data-dialog-cancel>' + escapeHtml(options.cancelLabel || 'Cancel') + '</button>') +
            '<button type="button" class="' + (options.danger ? 'btn-danger' : 'btn btn-primary') + '" data-dialog-confirm>' + escapeHtml(options.confirmLabel || 'Save') + '</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    const dialog = root.querySelector('.dialog');
    dialog.addEventListener('click', function (event) {
      if (options.onClick) options.onClick(event);
    });
    root.querySelector('[data-dialog-confirm]').addEventListener('click', confirmDialogAction);
    const cancel = root.querySelector('[data-dialog-cancel]');
    if (cancel) cancel.addEventListener('click', function () { cancelDialog(); });
    root.querySelector('[data-dialog-backdrop]').addEventListener('click', function (event) {
      if (event.target.hasAttribute('data-dialog-backdrop')) cancelDialog();
    });
    dialog.focus();
  }
  paint();
}

async function confirmDialogAction() {
  if (!dialogCtl) return;
  const dialog = document.querySelector('#dialog-root .dialog');
  const result = await dialogCtl.options.onConfirm(dialog);
  if (result === false) return;
  closeDialog();
}

function cancelDialog() {
  if (!dialogCtl) return;
  const onCancel = dialogCtl.options.onCancel;
  closeDialog();
  if (onCancel) onCancel();
}

function closeDialog() {
  const root = document.getElementById('dialog-root');
  const previous = dialogCtl && dialogCtl.previouslyFocused;
  if (root) root.innerHTML = '';
  dialogCtl = null;
  if (previous && typeof previous.focus === 'function') previous.focus();
}

function confirmDialog(message, options) {
  const opts = options || {};
  return new Promise(function (resolve) {
    let settled = false;
    function finish(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    }
    openDialog({
      title: opts.title || 'Please confirm',
      confirmLabel: opts.confirmLabel || 'Confirm',
      danger: !!opts.danger,
      render: function () { return '<p>' + escapeHtml(message) + '</p>'; },
      onConfirm: function () { finish(true); },
      onCancel: function () { finish(false); }
    });
  });
}

function informDialog(message, title) {
  return new Promise(function (resolve) {
    openDialog({
      title: title || 'Notice',
      confirmLabel: 'OK',
      hideCancel: true,
      render: function () { return '<p>' + escapeHtml(message) + '</p>'; },
      onConfirm: function () { resolve(); },
      onCancel: function () { resolve(); }
    });
  });
}

function onGlobalKeydown(event) {
  if (event.key === 'Escape' && dialogCtl) {
    event.preventDefault();
    cancelDialog();
    return;
  }
  if (event.key === ' ' && event.target && event.target.hasAttribute && event.target.hasAttribute('data-timer-board')) {
    event.preventDefault();
    if (timer.running) pauseTimer();
    else startTimer();
  }
  if (event.key === 'Tab' && dialogCtl) {
    const dialog = document.querySelector('#dialog-root .dialog');
    if (!dialog) return;
    const focusable = dialog.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    const list = Array.prototype.filter.call(focusable, function (el) {
      return !el.disabled && el.type !== 'hidden';
    });
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
}

function boot() {
  if (!document.getElementById('panel-meetings')) return;
  state = loadState();
  saveState();
  currentTab = tabFromHash();
  bindChrome();
  showTab(currentTab, { skipHash: true });
  window.addEventListener('hashchange', function () {
    showTab(tabFromHash());
  });
}

const TMWorkspace = {
  STORAGE_KEY: STORAGE_KEY,
  APP_ID: APP_ID,
  SCHEMA_VERSION: SCHEMA_VERSION,
  TZ: TZ,
  CLUBS: CLUBS,
  DEFAULT_ROLES: DEFAULT_ROLES,
  ymdInZone: ymdInZone,
  weekdayInZone: weekdayInZone,
  zonedDate: zonedDate,
  addDaysYmd: addDaysYmd,
  upcomingOccurrences: upcomingOccurrences,
  timingBands: timingBands,
  cueFromElapsed: cueFromElapsed,
  formatClock: formatClock,
  formatDuration: formatDuration,
  formatLongDate: formatLongDate,
  defaultState: defaultState,
  coerceState: coerceState,
  buildExportPayload: buildExportPayload,
  parseAndValidateImport: parseAndValidateImport,
  summarizeState: summarizeState
};

if (typeof window !== 'undefined') window.TMWorkspace = TMWorkspace;
if (typeof module !== 'undefined' && module.exports) module.exports = TMWorkspace;

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
