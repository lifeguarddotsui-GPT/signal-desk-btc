import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "@mysten/dapp-kit/dist/index.css";

createRoot(document.getElementById("root")!).render(<App />);
