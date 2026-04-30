const express = require('express');
const app = express();

app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('Clinic WhatsApp Bot is running ✅');
});

app.post('/webhook', (req, res) => {
  console.log('Received webhook:', req.body);
  res.set('Content-Type', 'text/xml');
  res.send('<Response><Message>Bot received your message. Setup in progress!</Message></Response>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
