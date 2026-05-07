const tripSelect = document.getElementById("trip");
const ridersInput = document.getElementById("riders");
const totalPriceEl = document.getElementById("total-price");
const bookingForm = document.getElementById("booking-form");
const bookingResult = document.getElementById("booking-result");
const tripButtons = document.querySelectorAll(".trip-select");
const currencyFormatter = new Intl.NumberFormat("nl-NL", {
  style: "currency",
  currency: "EUR",
  maximumFractionDigits: 0
});

function isLocalFileOpen() {
  return window.location.protocol === "file:";
}

function getSelectedTripPrice() {
  const option = tripSelect.options[tripSelect.selectedIndex];
  if (!option || !option.dataset.price) {
    return 0;
  }
  return Number(option.dataset.price);
}

function updateTotalPrice() {
  const pricePerPerson = getSelectedTripPrice();
  const riders = Number(ridersInput.value) || 0;
  const total = pricePerPerson * riders;

  totalPriceEl.textContent = currencyFormatter.format(total);
}

function setTripFromCard(tripName, price) {
  const optionToSelect = [...tripSelect.options].find((option) => option.value === tripName);

  if (!optionToSelect) {
    return;
  }

  optionToSelect.selected = true;
  if (!optionToSelect.dataset.price) {
    optionToSelect.dataset.price = String(price);
  }

  updateTotalPrice();
  document.getElementById("boeken").scrollIntoView({ behavior: "smooth", block: "start" });
}

tripButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setTripFromCard(button.dataset.trip, button.dataset.price);
  });
});

tripSelect.addEventListener("change", updateTotalPrice);
ridersInput.addEventListener("input", updateTotalPrice);

function getBookingPayload() {
  const formData = new FormData(bookingForm);
  return {
    trip: formData.get("trip")?.toString().trim(),
    name: formData.get("name")?.toString().trim(),
    email: formData.get("email")?.toString().trim(),
    date: formData.get("date")?.toString().trim(),
    riders: Number(formData.get("riders")),
    message: formData.get("message")?.toString().trim() || ""
  };
}

function showError(message) {
  bookingResult.innerHTML = `<div class="error">${message}</div>`;
}

function showSuccess(message) {
  bookingResult.innerHTML = `<div class="success">${message}</div>`;
}

async function confirmAfterReturn() {
  const params = new URLSearchParams(window.location.search);
  const paymentStatus = params.get("payment");
  const sessionId = params.get("session_id");

  if (paymentStatus === "cancelled") {
    showError("Betaling geannuleerd. Je boeking is niet afgerond.");
    return;
  }

  if (paymentStatus !== "success" || !sessionId) {
    return;
  }

  try {
    if (isLocalFileOpen()) {
      showError("Open de website via http://localhost:3000, niet als lokaal bestand.");
      return;
    }

    const response = await fetch("/api/confirm-booking", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sessionId })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      showError(result.error || "Betaling ontvangen, maar bevestiging mislukte.");
      return;
    }

    const booking = result.booking;
    showSuccess(
      `Top ${booking.name}! Je betaling is gelukt voor <strong>${booking.trip}</strong> op <strong>${booking.date}</strong> ` +
      `(${booking.riders} persoon/personen). Totaal: <strong>${currencyFormatter.format(booking.totalCents / 100)}</strong>. ` +
      `Bevestiging is verzonden naar ${booking.email}.`
    );

    window.history.replaceState({}, document.title, window.location.pathname);
  } catch (_error) {
    showError("Betaling lijkt gelukt, maar we kunnen de server niet bereiken. Controleer of de server draait op http://localhost:3000.");
  }
}

bookingForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (isLocalFileOpen()) {
    showError("Open de website via http://localhost:3000, niet als lokaal bestand.");
    return;
  }

  const payload = getBookingPayload();

  if (!payload.trip || !payload.name || !payload.email || !payload.date || payload.riders < 1) {
    showError("Controleer alle verplichte velden voordat je boekt.");
    return;
  }

  try {
    showSuccess("Je wordt doorgestuurd naar de veilige betaalpagina...");

    const response = await fetch("/api/create-booking-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok || !result.checkoutUrl) {
      showError(result.error || "Kon betaalpagina niet starten.");
      return;
    }

    localStorage.setItem("jobsMotorreizenLastBooking", JSON.stringify(payload));
    window.location.href = result.checkoutUrl;
  } catch (_error) {
    showError("Technische fout: we kunnen de server niet bereiken. Controleer of de website via http://localhost:3000 draait.");
  }
});

async function checkHealth() {
  const statusEl = document.getElementById("health-status");
  if (!statusEl) return;

  try {
    const response = await fetch("/api/health");
    const data = await response.json();

    if (data.ok && data.stripe) {
      statusEl.className = "health-status health-ok";
      statusEl.textContent = "✓ Backend & Stripe OK";
      statusEl.title = "Alles werkt goed!";
    } else {
      statusEl.className = "health-status health-error";
      const issues = data.message?.join(", ") || "Configuratiefout";
      statusEl.textContent = "⚠ Probleem: " + issues;
      statusEl.title = issues;
    }
  } catch (error) {
    statusEl.className = "health-status health-error";
    statusEl.textContent = "✗ Backend offline";
    statusEl.title = "Kan backend niet bereiken";
  }
}

checkHealth();
setInterval(checkHealth, 30000);

updateTotalPrice();
confirmAfterReturn();
