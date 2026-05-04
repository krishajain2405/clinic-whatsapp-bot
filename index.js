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

// ====== SLOT DEFINITIONS ======
const WEEKDAY_SLOTS = [
  "8:30 AM - 9:30 AM",
  "9:30 AM - 10:30 AM",
  "10:30 AM - 11:30 AM",
  "11:30 AM - 12:30 PM",
  "2:00 PM - 3:00 PM",
  "3:00 PM - 4:00 PM",
  "4:00 PM - 4:30 PM"
];

const SATURDAY_SLOTS = [
  "8:30 AM - 9:30 AM",
  "9:30 AM - 10:30 AM",
  "10:30 AM - 11:30 AM",
  "11:30 AM - 12:30 PM"
];

const MAX_PER_HOUR = 4;
const MAX_PER_HALFHOUR = 2;

// ====== HELPERS ======
async function callAppsScript(payload) {
  try {
    const res = await axios.post(APPS_SCRIPT_URL, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000
    });
    return res.data;
  } catch (err) {
    console.error("Apps Script error:", err.message);
    return { error: err.message };
  }
}

async function sendWhatsApp(to, body) {
  try {
    await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: to,
      body: body
    });
  } catch (err) {
    console.error("Twilio send error:", err.message);
  }
}

function isValidAge(t) { const n = parseInt(t); return !isNaN(n) && n >= 1 && n <= 120; }
function isValidPhone(t) { return /^[6-9]\d{9}$/.test(t.replace(/\s+/g, '')); }

// Generate next 10 days excluding Sundays, in IST
function getAvailableDates() {
  const dates = [];
  const today = new Date();
  // Adjust to IST
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(today.getTime() + istOffset);

  for (let i = 0; i < 10; i++) {
    const d = new Date(istNow);
    d.setDate(istNow.getDate() + i);
    if (d.getUTCDay() === 0) continue; // skip Sunday (0 = Sunday)
    dates.push({
      iso: d.toISOString().split('T')[0], // yyyy-MM-dd
      display: d.toUTCString().split(' ').slice(0, 3).join(' '), // "Mon, 05 May"
      dayOfWeek: d.getUTCDay() // 1-6 (Mon-Sat)
    });
  }
  return dates;
}

function getSlotsForDate(dateInfo) {
  return dateInfo.dayOfWeek === 6 ? SATURDAY_SLOTS : WEEKDAY_SLOTS;
}

function isHalfHourSlot(slot) {
  return slot.includes("4:00 PM - 4:30 PM");
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
      await sendWhatsApp(fromNumber, "👋 Welcome to Sunshine Clinic!\n\nSend 'Hi' to book an appointment.");
    }
    return;
  }

  switch (session.currentStep) {
    case "select_doctor": await handleDoctorSelection(fromNumber, messageBody, session); break;
    case "ask_name":      await handleName(fromNumber, messageBody, session); break;
    case "ask_age":       await handleAge(fromNumber, messageBody, session); break;
    case "ask_phone":     await handlePhone(fromNumber, messageBody, session); break;
    case "select_date":   await handleDateSelection(fromNumber, messageBody, session); break;
    case "select_slot":   await handleSlotSelection(fromNumber, messageBody, session); break;
    case "confirm":       await handleConfirmation(fromNumber, messageBody, session); break;
    default: await startBooking(fromNumber);
  }
});

// ====== HANDLERS ======
async function startBooking(phone) {
  const result = await callAppsScript({ action: "getDoctors" });
  const doctors = result.doctors || [];
  if (doctors.length === 0) {
    await sendWhatsApp(phone, "Sorry, no doctors available right now.");
    return;
  }
  let msg = "👋 Welcome to All Doctor's Clinic!\n\nPlease select your doctor:\n\n";
  doctors.forEach((d, i) => msg += `${i + 1}. ${d.name} (${d.specialty})\n`);
  msg += "\nReply with the number.";
  await callAppsScript({ action: "saveSession", phone: phone, currentStep: "select_doctor" });
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
  await callAppsScript({ action: "saveSession", phone: phone, currentStep: "ask_name", doctor: selected });
  await sendWhatsApp(phone, `✅ You selected ${selected}.\n\nPlease type your full name.`);
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
  await callAppsScript({
    action: "saveSession", phone: phone, currentStep: "ask_phone",
    doctor: session.doctor, patientName: session.patientName, age: text
  });
  await sendWhatsApp(phone, "Please share your 10-digit mobile number (starts with 6, 7, 8, or 9).");
}

async function handlePhone(phone, text, session) {
  const cleaned = text.replace(/\s+/g, '');
  if (!isValidPhone(cleaned)) {
    await sendWhatsApp(phone, "❌ Please enter a valid 10-digit Indian mobile number.");
    return;
  }
  // Move to date selection
  const dates = getAvailableDates();
  let msg = "📅 Please select your appointment date:\n\n";
  dates.forEach((d, i) => msg += `${i + 1}. ${d.display}\n`);
  msg += "\nReply with the number.";

  await callAppsScript({
    action: "saveSession", phone: phone, currentStep: "select_date",
    doctor: session.doctor, patientName: session.patientName, age: session.age
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

  // Check duplicate
  const cleanPhone = phone.replace("whatsapp:", "").replace("+", "");
  const dup = await callAppsScript({
    action: "checkDuplicate", phone: cleanPhone,
    doctor: session.doctor, date: selectedDate.iso
  });
  if (dup.duplicate) {
    await sendWhatsApp(phone, `⚠️ You already have a booking with ${session.doctor} on ${selectedDate.display}.\n\nSend 'reset' to start over.`);
    return;
  }

  // Get slots for that day, filter out full ones
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
    await sendWhatsApp(phone, `😔 Sorry, all slots are full for ${selectedDate.display}. Please pick another date.\n\nSend 'reset' to start over.`);
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
  // We store available slots indirectly — re-query at confirmation
  await sendWhatsApp(phone, msg);
}

async function handleSlotSelection(phone, text, session) {
  const choice = parseInt(text);
  // Re-compute available slots
  const dates = getAvailableDates();
  const dateInfo = dates.find(d => d.iso === session.date);
  if (!dateInfo) {
    await sendWhatsApp(phone, "⚠️ Date error. Please send 'reset' to start over.");
    return;
  }
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

  if (isNaN(choice) || choice < 1 || choice > availableSlots.length) {
    await sendWhatsApp(phone, `❌ Please reply with a number between 1 and ${availableSlots.length}.`);
    return;
  }

  const selectedSlot = availableSlots[choice - 1];
  const cleanPhone = phone.replace("whatsapp:", "").replace("+", "");

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
  const cleanPhone = phone.replace("whatsapp:", "").replace("+", "");

  if (choice === "1" || choice.toLowerCase().includes("confirm")) {
    // FINAL availability check before saving
    const cnt = await callAppsScript({
      action: "getSlotBookingCount",
      doctor: session.doctor, date: session.date, timeSlot: session.timeSlot
    });
    const cap = isHalfHourSlot(session.timeSlot) ? MAX_PER_HALFHOUR : MAX_PER_HOUR;
    if ((cnt.count || 0) >= cap) {
      await callAppsScript({ action: "deleteSession", phone: phone });
      await sendWhatsApp(phone, "😔 Sorry, that slot was just taken by someone else. Please send 'Hi' to start a new booking.");
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
      const dates = getAvailableDates();
      const dateInfo = dates.find(d => d.iso === session.date);
      const dateDisplay = dateInfo ? dateInfo.display : session.date;

      const confirmMsg =
        `✅ *Appointment Confirmed!*\n\n` +
        `👨‍⚕️ Doctor: ${session.doctor}\n` +
        `🧑 Patient: ${session.patientName}\n` +
        `🎂 Age: ${session.age}\n` +
        `📞 Contact: ${cleanPhone}\n` +
        `📅 Date: ${dateDisplay}\n` +
        `🕐 Time: ${session.timeSlot}\n` +
        `🎫 Token: *${result.token}*\n\n` +
        `Please arrive 10 minutes before your slot.\n` +
        `To cancel, reply: CANCEL ${result.bookingId}\n\n` +
        `Thank you! 🙏`;
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
