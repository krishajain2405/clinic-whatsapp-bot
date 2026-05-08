const express = require('express');
const axios = require('axios');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ====== CONFIG ======
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER;
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const WEEKDAY_SLOTS = [
  "8:30 AM - 9:30 AM", "9:30 AM - 10:30 AM", "10:30 AM - 11:30 AM",
  "11:30 AM - 12:30 PM", "2:00 PM - 3:00 PM", "3:00 PM - 4:00 PM",
  "4:00 PM - 4:30 PM"
];
const SATURDAY_SLOTS = [
  "8:30 AM - 9:30 AM", "9:30 AM - 10:30 AM",
  "10:30 AM - 11:30 AM", "11:30 AM - 12:30 PM"
];

const MAX_PER_HOUR = 4;
const MAX_PER_HALFHOUR = 2;
const BUFFER_MIN = 15;

// ====== TIME HELPERS ======
function getISTNow() {
  const fmt = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'short'
  });
  const parts = fmt.formatToParts(new Date());
  const get = (t) => parts.find(p => p.type === t).value;
  const year = parseInt(get('year'));
  const month = parseInt(get('month'));
  const date = parseInt(get('day'));
  let hour = parseInt(get('hour'));
  if (hour === 24) hour = 0;
  const minute = parseInt(get('minute'));
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = dayMap[get('weekday')];
  return { year, month, date, day, hour, minute, totalMinutes: hour * 60 + minute };
}

function addDaysIST(baseYear, baseMonth, baseDate, daysToAdd) {
  const d = new Date(Date.UTC(baseYear, baseMonth - 1, baseDate));
  d.setUTCDate(d.getUTCDate() + daysToAdd);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const dt = d.getUTCDate();
  const dow = d.getUTCDay();
  const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const iso = `${y}-${String(m).padStart(2,'0')}-${String(dt).padStart(2,'0')}`;
  const display = `${dayNames[dow]}, ${String(dt).padStart(2,'0')} ${monthNames[m-1]}`;
  return { year: y, month: m, date: dt, day: dow, iso, display };
}

function slotStartMinutes(slot) {
  const start = slot.split("-")[0].trim();
  const m = start.match(/(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return 0;
  let hh = parseInt(m[1]);
  const mm = parseInt(m[2]);
  const ampm = m[3].toUpperCase();
  if (ampm === "PM" && hh !== 12) hh += 12;
  if (ampm === "AM" && hh === 12) hh = 0;
  return hh * 60 + mm;
}

function getAvailableDates() {
  const dates = [];
  const ist = getISTNow();
  for (let i = 0; i < 10; i++) {
    const d = addDaysIST(ist.year, ist.month, ist.date, i);
    if (d.day === 0) continue;
    if (i === 0) {
      const slotsToday = (d.day === 6) ? SATURDAY_SLOTS : WEEKDAY_SLOTS;
      const hasFutureSlot = slotsToday.some(s => slotStartMinutes(s) >= ist.totalMinutes + BUFFER_MIN);
      if (!hasFutureSlot) continue;
    }
    dates.push({ ...d, isToday: (i === 0) });
  }
  return dates;
}

function getSlotsForDate(dateInfo) {
  const allSlots = (dateInfo.day === 6) ? SATURDAY_SLOTS : WEEKDAY_SLOTS;
  if (!dateInfo.isToday) return allSlots;
  const ist = getISTNow();
  return allSlots.filter(s => slotStartMinutes(s) >= ist.totalMinutes + BUFFER_MIN);
}

function isHalfHourSlot(slot) { return slot.includes("4:00 PM - 4:30 PM"); }

function getDateInfoFromISO(iso) {
  const dates = getAvailableDates();
  const found = dates.find(d => d.iso === iso);
  if (found) return found;
  const [y, m, dt] = iso.split('-').map(Number);
  const d = addDaysIST(y, m, dt, 0);
  const ist = getISTNow();
  const isToday = (d.year === ist.year && d.month === ist.month && d.date === ist.date);
  return { ...d, isToday };
}

// ====== HELPERS ======
async function callAppsScript(payload) {
  try {
    const res = await axios.post(APPS_SCRIPT_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 20000
    });
    return res.data;
  } catch (err) {
    console.error("Apps Script error:", err.message);
    return { error: err.message };
  }
}

async function sendWhatsApp(to, body) {
  try {
    await twilioClient.messages.create({ from: TWILIO_WHATSAPP_NUMBER, to: to, body: body });
  } catch (err) {
    console.error("Twilio send error:", err.message);
  }
}

function isValidAge(t) { const n = parseInt(t); return !isNaN(n) && n >= 1 && n <= 120; }
function isValidPhone(t) { return /^[6-9]\d{9}$/.test(t.replace(/\s+/g, '')); }

function extractCleanPhone(whatsappFrom) {
  // "whatsapp:+919876543210" -> "9876543210"
  return whatsappFrom.replace("whatsapp:", "").replace("+", "").slice(-10);
}

// ====== HEALTH CHECK ======
app.get('/', (req, res) => res.send('Clinic WhatsApp Bot is running ✅'));

// ====== WEBHOOK ======
app.post('/webhook', async (req, res) => {
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  const fromNumber = req.body.From;
  const messageBody = (req.body.Body || "").trim();
  console.log(`Incoming from ${fromNumber}: ${messageBody}`);
  if (!fromNumber || !messageBody) return;

  const session = await callAppsScript({ action: "getSession", phone: fromNumber });

  if (["reset", "restart"].includes(messageBody.toLowerCase())) {
    await callAppsScript({ action: "deleteSession", phone: fromNumber });
    await sendWhatsApp(fromNumber, "🔄 Conversation reset. Send 'Hi' to start booking.");
    return;
  }

  if (!session.found) {
    if (["hi", "hello", "hey", "book", "start"].includes(messageBody.toLowerCase())) {
      await startBooking(fromNumber);
    } else {
      await sendWhatsApp(fromNumber, "👋 Welcome to All Doctors Clinic!\n\nSend 'Hi' to book an appointment.");
    }
    return;
  }

  switch (session.currentStep) {
    case "select_doctor": await handleDoctorSelection(fromNumber, messageBody, session); break;
    case "ask_name":      await handleName(fromNumber, messageBody, session); break;
    case "ask_age":       await handleAge(fromNumber, messageBody, session); break;
    case "select_date":   await handleDateSelection(fromNumber, messageBody, session); break;
    case "select_slot":   await handleSlotSelection(fromNumber, messageBody, session); break;
    case "confirm":       await handleConfirmation(fromNumber, messageBody, session); break;
    default: await startBooking(fromNumber);
  }
});

// ====== HANDLERS ======
async function startBooking(phone) {
  // STEP 5 NEW: Try to recognize returning patient by their phone
  const cleanPhone = extractCleanPhone(phone);
  const patient = await callAppsScript({ action: "lookupPatient", phone: cleanPhone });

  const result = await callAppsScript({ action: "getDoctors" });
  const doctors = result.doctors || [];
  if (doctors.length === 0) {
    await sendWhatsApp(phone, "Sorry, no doctors available right now.");
    return;
  }

  let greeting;
  let sessionData = { phone: phone, currentStep: "select_doctor" };

  if (patient.found && patient.name) {
    // Returning patient — store their info in session, skip name/age later
    greeting = `👋 Welcome back, ${patient.name}!\n\nPlease select your doctor:\n\n`;
    sessionData.patientName = patient.name;
    sessionData.age = patient.age || "";
  } else {
    greeting = "👋 Welcome to Sunshine Clinic!\n\nPlease select your doctor:\n\n";
  }

  let msg = greeting;
  doctors.forEach((d, i) => msg += `${i + 1}. ${d.name} (${d.specialty})\n`);
  msg += "\nReply with the number.";

  await callAppsScript({ action: "saveSession", ...sessionData });
  await sendWhatsApp(phone, msg);
}

async function handleDoctorSelection(phone, text, session) {
  const result = await callAppsScript({ action: "getDoctors" });
  const doctors = result.doctors || [];
  const choice = parseInt(text);
  if (isNaN(choice) || choice < 1 || choice > doctors.length) {
    await sendWhatsApp(phone, `❌ Please reply with a number between 1 and ${doctors.length}.`);
    return;
  }
  const selected = doctors[choice - 1].name;

  // STEP 5 NEW: If returning patient (we already have name + age), skip to date selection
  if (session.patientName && session.age) {
    await callAppsScript({
      action: "saveSession", phone: phone, currentStep: "select_date",
      doctor: selected, patientName: session.patientName, age: session.age
    });
    const dates = getAvailableDates();
    if (dates.length === 0) {
      await sendWhatsApp(phone, "😔 Sorry, no booking dates are available right now.");
      return;
    }
    let msg = `✅ You selected ${selected}.\n\n📅 Please select your appointment date:\n\n`;
    dates.forEach((d, i) => msg += `${i + 1}. ${d.display}\n`);
    msg += "\nReply with the number.";
    await sendWhatsApp(phone, msg);
  } else {
    // New patient — ask for name first
    await callAppsScript({ action: "saveSession", phone: phone, currentStep: "ask_name", doctor: selected });
    await sendWhatsApp(phone, `✅ You selected ${selected}.\n\nPlease type your full name.`);
  }
}

async function handleName(phone, text, session) {
  if (text.length < 2 || !/^[a-zA-Z\s.]+$/.test(text)) {
    await sendWhatsApp(phone, "❌ Please enter a valid name (letters only, at least 2 characters).");
    return;
  }
  await callAppsScript({
    action: "saveSession", phone: phone, currentStep: "ask_age",
    doctor: session.doctor, patientName: text
  });
  await sendWhatsApp(phone, `Thanks ${text}!\n\nPlease enter your age (numbers only).`);
}

async function handleAge(phone, text, session) {
  if (!isValidAge(text)) {
    await sendWhatsApp(phone, "❌ Please enter a valid age between 1 and 120.");
    return;
  }
  // Move to date selection (we already have phone from WhatsApp)
  const dates = getAvailableDates();
  if (dates.length === 0) {
    await sendWhatsApp(phone, "😔 Sorry, no booking dates are available right now. Please try again later.");
    return;
  }
  let msg = "📅 Please select your appointment date:\n\n";
  dates.forEach((d, i) => msg += `${i + 1}. ${d.display}\n`);
  msg += "\nReply with the number.";

  await callAppsScript({
    action: "saveSession", phone: phone, currentStep: "select_date",
    doctor: session.doctor, patientName: session.patientName, age: text
  });
  await sendWhatsApp(phone, msg);
}

async function handleDateSelection(phone, text, session) {
  const dates = getAvailableDates();
  const choice = parseInt(text);
  if (isNaN(choice) || choice < 1 || choice > dates.length) {
    await sendWhatsApp(phone, `❌ Please reply with a number between 1 and ${dates.length}.`);
    return;
  }
  const selectedDate = dates[choice - 1];

  const cleanPhone = extractCleanPhone(phone);
  const dup = await callAppsScript({
    action: "checkDuplicate", phone: cleanPhone,
    doctor: session.doctor, date: selectedDate.iso
  });
  if (dup.duplicate) {
    await sendWhatsApp(phone, `⚠️ You already have a booking with ${session.doctor} on ${selectedDate.display}.\n\nSend 'reset' to start over.`);
    return;
  }

  const slotsForDay = getSlotsForDate(selectedDate);
  const availableSlots = [];
  for (const slot of slotsForDay) {
    const cnt = await callAppsScript({
      action: "getSlotBookingCount",
      doctor: session.doctor, date: selectedDate.iso, timeSlot: slot
    });
    const cap = isHalfHourSlot(slot) ? MAX_PER_HALFHOUR : MAX_PER_HOUR;
    if ((cnt.count || 0) < cap) availableSlots.push({ slot: slot, left: cap - (cnt.count || 0) });
  }

  if (availableSlots.length === 0) {
    await sendWhatsApp(phone, `😔 Sorry, no slots available for ${selectedDate.display}. Please pick another date.\n\nSend 'reset' to start over.`);
    return;
  }

  let msg = `🕐 Available slots for ${selectedDate.display}:\n\n`;
  availableSlots.forEach((s, i) => msg += `${i + 1}. ${s.slot} (${s.left} seat${s.left > 1 ? 's' : ''} left)\n`);
  msg += "\nReply with the number.";

  await callAppsScript({
    action: "saveSession", phone: phone, currentStep: "select_slot",
    doctor: session.doctor, patientName: session.patientName,
    age: session.age, date: selectedDate.iso
  });
  await sendWhatsApp(phone, msg);
}

async function handleSlotSelection(phone, text, session) {
  const choice = parseInt(text);
  const dateInfo = getDateInfoFromISO(session.date);
  const slotsForDay = getSlotsForDate(dateInfo);
  const availableSlots = [];
  for (const slot of slotsForDay) {
    const cnt = await callAppsScript({
      action: "getSlotBookingCount",
      doctor: session.doctor, date: session.date, timeSlot: slot
    });
    const cap = isHalfHourSlot(slot) ? MAX_PER_HALFHOUR : MAX_PER_HOUR;
    if ((cnt.count || 0) < cap) availableSlots.push(slot);
  }
  if (availableSlots.length === 0) {
    await sendWhatsApp(phone, "😔 No slots available anymore. Please send 'reset' and try again.");
    return;
  }
  if (isNaN(choice) || choice < 1 || choice > availableSlots.length) {
    await sendWhatsApp(phone, `❌ Please reply with a number between 1 and ${availableSlots.length}.`);
    return;
  }

  const selectedSlot = availableSlots[choice - 1];
  const cleanPhone = extractCleanPhone(phone);

  await callAppsScript({
    action: "saveSession", phone: phone, currentStep: "confirm",
    doctor: session.doctor, patientName: session.patientName,
    age: session.age, date: session.date, timeSlot: selectedSlot
  });

  const summary =
    `📋 *Please confirm your appointment:*\n\n` +
    `👨‍⚕️ Doctor: ${session.doctor}\n` +
    `🧑 Patient: ${session.patientName}\n` +
    `🎂 Age: ${session.age}\n` +
    `📞 Phone: ${cleanPhone}\n` +
    `📅 Date: ${dateInfo.display}\n` +
    `🕐 Time: ${selectedSlot}\n\n` +
    `1. ✅ Confirm Appointment\n` +
    `2. ✏️ Make Changes\n\nReply with 1 or 2.`;
  await sendWhatsApp(phone, summary);
}

async function handleConfirmation(phone, text, session) {
  const choice = text.trim();
  const cleanPhone = extractCleanPhone(phone);

  if (choice === "1" || choice.toLowerCase().includes("confirm")) {
    const cnt = await callAppsScript({
      action: "getSlotBookingCount",
      doctor: session.doctor, date: session.date, timeSlot: session.timeSlot
    });
    const cap = isHalfHourSlot(session.timeSlot) ? MAX_PER_HALFHOUR : MAX_PER_HOUR;
    if ((cnt.count || 0) >= cap) {
      await callAppsScript({ action: "deleteSession", phone: phone });
      await sendWhatsApp(phone, "😔 Sorry, that slot was just taken. Please send 'Hi' to start a new booking.");
      return;
    }

    const result = await callAppsScript({
      action: "saveBooking",
      doctor: session.doctor, patientName: session.patientName,
      age: session.age, phone: cleanPhone,
      date: session.date, timeSlot: session.timeSlot
    });
    await callAppsScript({ action: "deleteSession", phone: phone });

    if (result.success) {
      const dateInfo = getDateInfoFromISO(session.date);
      const confirmMsg =
        `✅ *Appointment Confirmed!*\n\n` +
        `👨‍⚕️ Doctor: ${session.doctor}\n` +
        `🧑 Patient: ${session.patientName}\n` +
        `🎂 Age: ${session.age}\n` +
        `📞 Contact: ${cleanPhone}\n` +
        `📅 Date: ${dateInfo.display}\n` +
        `🕐 Time: ${session.timeSlot}\n` +
        `🎫 Token: *${result.token}*\n\n` +
        `Please arrive 10 minutes before your slot.\n` +
        `To cancel, reply: CANCEL ${result.bookingId}\n\nThank you! 🙏`;
      await sendWhatsApp(phone, confirmMsg);
    } else if (result.error === "SLOT_FULL") {
      await sendWhatsApp(phone, "😔 Sorry, that slot just got filled. Please send 'Hi' to book again.");
    } else {
      await sendWhatsApp(phone, "⚠️ Something went wrong. Please try again or contact the clinic.");
    }
  } else if (choice === "2" || choice.toLowerCase().includes("change")) {
    await callAppsScript({ action: "deleteSession", phone: phone });
    await startBooking(phone);
  } else {
    await sendWhatsApp(phone, "❌ Please reply with 1 to Confirm or 2 to Make Changes.");
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
