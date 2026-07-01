import "virtual:uno.css";
import "./assets/fonts.css";
import { createPinia } from "pinia";
import { createApp } from "vue";
import App from "./App.vue";

const app = createApp(App);

// Global error handler — prevents silent white-screen on unhandled component errors
app.config.errorHandler = (err, _instance, info) => {
  console.error("[vibeflow] unhandled component error:", info, err);
  // Surface to user only if the error is fatal enough to prevent rendering
  // (Vue will already log the component trace)
};

// Catch unhandled promise rejections from non-Vue code
window.addEventListener("unhandledrejection", (e) => {
  console.error("[vibeflow] unhandled promise rejection:", e.reason);
});

app.use(createPinia()).mount("#app");
