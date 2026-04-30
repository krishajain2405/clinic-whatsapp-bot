const express = require('express');
const axios = require('axios');
const twilio = require('twilio');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ====== CONFIG (loaded from environment variables) ======
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_NUMBER = process.env.TWILIO_WHATSAPP_NUMBER; // e.g., "whatsapp:+14155238886"
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ====== TIME SLOTS (you can customize) ======
const TIME_SLOTS = [
  "10:00 AM - 11:00 AM",
  "11:00 AM - 12:00 PM",
  "12:00 PM - 1:00 PM",
  "4:00 PM - 5:00 PM",
  "5:00 PM - 6:00 PM"
];

// ====== HELPERS ======
async function callAppsScript(payload) {
  try {
    const res = await axios.post(APPS_SCRIPT_URL, payload, {
      headers: { 'Content-Type': 'application/json' }
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

function isValidAge(text) {
  const n = parseInt(text);
  return !isNaN(n) && n >= 1 && n <= 120;
}

function isValidPhone(text) {
  return /^[6-9]\d{9}$/.test(text.replace(/\s+/g, ''));
}

// ====== HEALTH CHECK ======
app.get('/', (req, res) => {
  res.send('Clinic WhatsApp Bot is running ✅');
});

// ====== MAIN WEBHOOK ======
app.post('/webhook', async (req, res) => {
  // Acknowledge Twilio immediately
  res.set('Content-Type', 'text/xml');
  res.send('<Response></Response>');

  const fromNumber = req.body.From;        // e.g., "whatsapp:+91987..."
  const messageBody = (req.body.Body || "").trim();
  console.log(`Incoming from ${fromNumber}: ${messageBody}`);

  if (!fromNumber || !messageBody) return;

  // Get current session
  const session = await callAppsScript({ action: "getSession", phone: fromNumber });

  // Reset command
  if (messageBody.toLowerCase() === "reset" || messageBody.toLowerCase() === "restart") {
    await callAppsScript({ action: "deleteSession", phone: fromNumber });
    await sendWhatsApp(fromNumber, "🔄 Conversation reset. Send 'Hi' to start booking.");
    return;
  }

  // No active session → start fresh
  if (!session.found) {
    if (["hi", "hello", "hey", "book", "start"].includes(messageBody.toLowerCase())) {
      await startBooking(fromNumber);
    } else {
      await sendWhatsApp(fromNumber, "👋 Welcome to Sunshine Clinic!\n\nSend 'Hi' to book an appointment.");
    }
    return;
  }

  // Route based on current step
  switch (session.currentStep) {
    case "select_doctor":
      await handleDoctorSelection(fromNumber, messageBody, session);
      break;
    case "ask_name":
      await handleName(fromNumber, messageBody, session);
      break;
    case "ask_age":
      await handleAge(fromNumber, messageBody, session);
      break;
    case "ask_phone":
      await handlePhone(fromNumber, messageBody, session);
      break;
    case "select_slot":
      await handleSlotSelection(fromNumber, messageBody, session);
      break;
    case "confirm":
      await handleConfirmation(fromNumber, messageBody, session);
      break;
    default:
      await startBooking(fromNumber);
  }
});

// ====== FLOW HANDLERS ======
async function startBooking(phone) {
  const result = await callAppsScript({ action: "getDoctors" });
  const doctors = result.doctors || [];

  if (doctors.length === 0) {
    await sendWhatsApp(phone, "Sorry, no doctors are available right now. Please try later.");
    return;
  }

  let msg = "👋 Welcome to Sunshine Clinic!\n\nPlease select your doctor:\n\n";
  doctors.forEach((d, i) => {
    msg += `${i + 1}. ${d.name} (${d.specialty})\n`;
  });
  msg += "\nReply with the number (1, 2, 3...).";

  await callAppsScript({
    action: "saveSession",
    phone: phone,
    currentStep: "select_doctor"
  });

  await sendWhatsApp(phone, msg);
}

async function handleDoctorSelection(phone, text, session) {
  const result = await callAppsScript({ action: "getDoctors" });
  const doctors = result.doctors || [];
  const choice = parseInt(text);

  if (isNaN(choice) || choice < 1 || choice > doctors.length) {
    await sendWhatsApp(phone, `❌ Invalid choice. Please reply with a number between 1 and ${doctors.length}.`);
    return;
  }

  const selectedDoctor = doctors[choice - 1].name;

  await callAppsScript({
    action: "saveSession",
    phone: phone,
    currentStep: "ask_name",
    doctor: selectedDoctor
  });

  await sendWhatsApp(phone, `✅ You selected ${selectedDoctor}.\n\nPlease type your full name.`);
}

async function handleName(phone, text, session) {
  if (text.length < 2 || !/^[a-zA-Z\s.]+$/.test(text)) {
    await sendWhatsApp(phone, "❌ Please enter a valid name (letters only, at least 2 characters).");
    return;
  }

  await callAppsScript({
    action: "saveSession",
    phone: phone,
    currentStep: "ask_age",
    doctor: session.doctor,
    patientName: text
  });

  await sendWhatsApp(phone, `Thanks ${text}!\n\nPlease enter your age (numbers only). Example: 35`);
}

async function handleAge(phone, text, session) {
  if (!isValidAge(text)) {
    await sendWhatsApp(phone, "❌ Please enter a valid age between 1 and 120.");
    return;
  }

  await callAppsScript({
    action: "saveSession",
    phone: phone,
    currentStep: "ask_phone",
    doctor: session.doctor,
    patientName: session.patientName,
    age: text
  });

  await sendWhatsApp(phone, "Please share your 10-digit mobile number (starts with 6, 7, 8, or 9).\n\nExample: 9876543210");
}

async function handlePhone(phone, text, session) {
  const cleaned = text.replace(/\s+/g, '');
  if (!isValidPhone(cleaned)) {
    await sendWhatsApp(phone, "❌ Please enter a valid 10-digit Indian mobile number starting with 6, 7, 8, or 9.");
    return;
  }

  // Build slot list
  let msg = "Please select your preferred time slot:\n\n";
  TIME_SLOTS.forEach((s, i) => {
    msg += `${i + 1}. ${s}\n`;
  });
  msg += "\nReply with the number.";

  await callAppsScript({
    action: "saveSession",
    phone: phone,
    currentStep: "select_slot",
    doctor: session.doctor,
    patientName: session.patientName,
    age: session.age
  });

  // Note: contact phone is the WhatsApp from-number
  await sendWhatsApp(phone, msg);
}

async function handleSlotSelection(phone, text, session) {
  const choice = parseInt(text);
  if (isNaN(choice) || choice < 1 || choice > TIME_SLOTS.length) {
    await sendWhatsApp(phone, `❌ Invalid choice. Reply with a number between 1 and ${TIME_SLOTS.length}.`);
    return;
  }

  const selectedSlot = TIME_SLOTS[choice - 1];
  const cleanPhone = phone.replace("whatsapp:", "").replace("+", "");

  await callAppsScript({
    action: "saveSession",
    phone: phone,
    currentStep: "confirm",
    doctor: session.doctor,
    patientName: session.patientName,
    age: session.age,
    timeSlot: selectedSlot
  });

  const summary =
    `📋 *Please confirm your appointment:*\n\n` +
    `👨‍⚕️ Doctor: ${session.doctor}\n` +
    `🧑 Patient: ${session.patientName}\n` +
    `🎂 Age: ${session.age}\n` +
    `📞 Phone: ${cleanPhone}\n` +
    `🕐 Time Slot: ${selectedSlot}\n\n` +
    `1. ✅ Confirm Appointment\n` +
    `2. ✏️ Make Changes\n\n` +
    `Reply with 1 or 2.`;

  await sendWhatsApp(phone, summary);
}

async function handleConfirmation(phone, text, session) {
  const choice = text.trim();
  const cleanPhone = phone.replace("whatsapp:", "").replace("+", "");

  if (choice === "1" || choice.toLowerCase().includes("confirm")) {
    const result = await callAppsScript({
      action: "saveBooking",
      doctor: session.doctor,
      patientName: session.patientName,
      age: session.age,
      phone: cleanPhone,
      timeSlot: session.timeSlot
    });

    await callAppsScript({ action: "deleteSession", phone: phone });

    if (result.success) {
      const confirmMsg =
        `✅ *Appointment Confirmed!*\n\n` +
        `🆔 Booking ID: ${result.bookingId}\n` +
        `👨‍⚕️ Doctor: ${session.doctor}\n` +
        `🕐 Slot: ${session.timeSlot}\n\n` +
        `Please arrive 10 minutes early. To cancel, send 'CANCEL ${result.bookingId}'.\n\nThank you! 🙏`;
      await sendWhatsApp(phone, confirmMsg);
    } else {
      await sendWhatsApp(phone, "⚠️ Sorry, something went wrong saving your booking. Please try again or contact the clinic.");
    }
  } else if (choice === "2" || choice.toLowerCase().includes("change")) {
    await callAppsScript({ action: "deleteSession", phone: phone });
    await startBooking(phone);
  } else {
    await sendWhatsApp(phone, "❌ Please reply with 1 to Confirm or 2 to Make Changes.");
  }
}

// ====== START ======
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
