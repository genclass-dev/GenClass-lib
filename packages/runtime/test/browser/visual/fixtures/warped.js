// A string cut through an emoji (a lone high surrogate): HTML cannot carry one, so the fixture sets it from script.
document.getElementById("cut").textContent = "Great deal \ud83d";
