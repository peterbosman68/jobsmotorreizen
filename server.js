const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const express = require("express");
const nodemailer = require("nodemailer");
const Stripe = require("stripe");
require("dotenv").config();

const app = express();
const port = Number(process.env.PORT || 3000);
const siteUrl = process.env.SITE_URL || `http://localhost:${port}`;
const bookingsFilePath = path.join(__dirname, "bookings.json");

const trips = {
  "Harz Classic": { days: 4, price: 59500 },
  "Kroatie Kusttour": { days: 7, price: 119000 },
  "Italia Alpenmix": { days: 6, price: 109500 }
};

const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? new Stripe(stripeKey) : null;

function readBookings() {
  try {
    const raw = fs.readFileSync(bookingsFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function writeBookings(bookings) {
  fs.writeFileSync(bookingsFilePath, JSON.stringify(bookings, null, 2));
}

function updateBookingBySessionId(sessionId, updater) {
  const bookings = readBookings();
  const index = bookings.findIndex((item) => item.sessionId === sessionId);
  if (index === -1) {
    return null;
  }

  const updated = updater(bookings[index]);
  bookings[index] = updated;
  writeBookings(bookings);
  return updated;
}

function createMailTransport() {
  const host = process.env.SMTP_HOST;
  const portValue = Number(process.env.SMTP_PORT || 587);
  const secure = String(process.env.SMTP_SECURE || "false") === "true";
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port: portValue,
    secure,
    auth: {
      user,
      pass
    }
  });
}

async function sendBookingEmails(booking) {
  const transporter = createMailTransport();
  const fromEmail = process.env.FROM_EMAIL;
  const ownerEmail = process.env.OWNER_EMAIL;

  if (!transporter || !fromEmail || !ownerEmail) {
    return;
  }

  const totalInEur = (booking.totalCents / 100).toLocaleString("nl-NL", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0
  });

  const subjectOwner = `Nieuwe boeking: ${booking.trip}`;
  const textOwner = [
    "Er is een nieuwe betaalde boeking binnengekomen.",
    `Reis: ${booking.trip}`,
    `Naam: ${booking.name}`,
    `E-mail: ${booking.email}`,
    `Startdatum: ${booking.date}`,
    `Aantal personen: ${booking.riders}`,
    `Totaal: ${totalInEur}`
  ].join("\n");

  const subjectCustomer = `Bevestiging boeking ${booking.trip}`;
  const textCustomer = [
    `Hoi ${booking.name},`,
    "",
    "Je boeking is bevestigd. Super dat je meegaat!",
    `Reis: ${booking.trip}`,
    `Startdatum: ${booking.date}`,
    `Aantal personen: ${booking.riders}`,
    `Totaal: ${totalInEur}`,
    "",
    "Tot snel op de motor,",
    "Job's Motorreizen"
  ].join("\n");

  await transporter.sendMail({
    from: fromEmail,
    to: ownerEmail,
    subject: subjectOwner,
    text: textOwner
  });

  await transporter.sendMail({
    from: fromEmail,
    to: booking.email,
    subject: subjectCustomer,
    text: textCustomer
  });
}

app.use(express.json());
app.use(express.static(__dirname));

app.get("/api/health", (_req, res) => {
  const checks = {
    ok: true,
    stripe: !!stripe,
    message: []
  };

  if (!stripe) {
    checks.ok = false;
    checks.message.push("Stripe niet ingesteld (STRIPE_SECRET_KEY ontbreekt)");
  }

  res.json(checks);
});

app.post("/api/create-booking-session", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe is nog niet ingesteld." });
    }

    const { trip, name, email, date, riders, message } = req.body || {};
    const selectedTrip = trips[trip];
    const ridersCount = Number(riders);

    if (!selectedTrip || !name || !email || !date || !Number.isInteger(ridersCount) || ridersCount < 1 || ridersCount > 8) {
      return res.status(400).json({ error: "Controleer de ingevulde velden." });
    }

    const totalCents = selectedTrip.price * ridersCount;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card", "ideal"],
      success_url: `${siteUrl}/?payment=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/?payment=cancelled`,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "eur",
            product_data: {
              name: `${trip} (${ridersCount} persoon/personen)`
            },
            unit_amount: totalCents
          }
        }
      ],
      customer_email: email,
      metadata: {
        trip,
        name,
        email,
        date,
        riders: String(ridersCount),
        message: String(message || "")
      }
    });

    const bookings = readBookings();
    bookings.push({
      id: randomUUID(),
      sessionId: session.id,
      paymentStatus: "pending",
      emailSent: false,
      createdAt: new Date().toISOString(),
      trip,
      name,
      email,
      date,
      riders: ridersCount,
      message: String(message || ""),
      totalCents
    });
    writeBookings(bookings);

    return res.json({ checkoutUrl: session.url });
  } catch (error) {
    return res.status(500).json({ error: "Kon betaalpagina niet starten." });
  }
});

app.post("/api/confirm-booking", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe is nog niet ingesteld." });
    }

    const { sessionId } = req.body || {};
    if (!sessionId) {
      return res.status(400).json({ error: "Sessie ontbreekt." });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || session.payment_status !== "paid") {
      return res.status(400).json({ error: "Betaling is nog niet bevestigd." });
    }

    const updatedBooking = updateBookingBySessionId(sessionId, (existing) => ({
      ...existing,
      paymentStatus: "paid",
      paidAt: new Date().toISOString()
    }));

    if (!updatedBooking) {
      return res.status(404).json({ error: "Boeking niet gevonden." });
    }

    if (!updatedBooking.emailSent) {
      try {
        await sendBookingEmails(updatedBooking);
        updateBookingBySessionId(sessionId, (existing) => ({
          ...existing,
          emailSent: true,
          emailSentAt: new Date().toISOString()
        }));
      } catch (mailError) {
        return res.status(500).json({ error: "Betaling gelukt, maar e-mail kon niet verzonden worden." });
      }
    }

    return res.json({
      ok: true,
      booking: {
        trip: updatedBooking.trip,
        name: updatedBooking.name,
        date: updatedBooking.date,
        riders: updatedBooking.riders,
        totalCents: updatedBooking.totalCents,
        email: updatedBooking.email
      }
    });
  } catch (error) {
    return res.status(500).json({ error: "Kon boeking niet bevestigen." });
  }
});

app.listen(port, () => {
  console.log(`Job's Motorreizen server draait op ${siteUrl}`);
});
