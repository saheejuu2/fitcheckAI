"use client";

import Image from "next/image";
import Script from "next/script";
import { ArrowRight, Camera, ChevronLeft, ChevronRight, Upload } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import type { createDecartClient } from "@decartai/sdk";
import { motion, useReducedMotion, type Variants } from "framer-motion";
import { SocialLinks } from "../SocialLinks";
import { GarmentCutoutError, prepareGarmentCutout, removeGarmentBackground } from "@/lib/garment-cutout";
import { stepProblem, toSubmission, type SurveyAnswers, type SurveyDefinition } from "@/lib/surveyDefinition";
import { SurveyQuestionField } from "./SurveyQuestionField";

const GARMENTS = {
  bomber: { name: "Floating Brand Bomber", displayName: ["Floating Brand", "Bomber"], image: "/floating-jacket.webp", prompt: "Dress the person in the cobalt technical bomber jacket from the reference. Preserve its ribbed cuffs and hem, sleeve pocket, zipper, face, body shape, pose and background." },
  shirt: { name: "Embroidered Long-Sleeve Shirt", displayName: ["Embroidered", "Shirt"], image: "/floating-shirt.webp", prompt: "Dress the person in the ivory long-sleeve button-up shirt with intricate cobalt and navy embroidery and chest pockets shown in the reference. Preserve its pattern, the person's face, body shape, pose and background." },
  barong: { name: "Midnight Barong", displayName: ["Midnight", "Barong"], image: "/floating-barong.webp", prompt: "Dress the person in the modern ivory embroidered Filipino barong from the reference. Preserve its embroidery, the person's face, body shape, pose and background." },
  dress: { name: "Black Empire Midi Dress", displayName: ["Black Midi", "Dress"], image: "/black-empire-midi-dress.png", prompt: "Dress the person in the black embroidered empire-waist midi dress shown in the reference. Preserve its bodice embroidery, short puff sleeves, empire seam, full A-line skirt, and hem stitching, as well as the person's face, body shape, pose and background." },
  cardigan: { name: "Navy-Green Knit Cardigan", displayName: ["Navy-Green", "Cardigan"], image: "/navy-green-knit-cardigan.png", prompt: "Dress the person in the dark navy-green collared knit cardigan shown in the reference. Preserve its fine-gauge ribbed texture, pointed collar, front button placket, purple-tipped cuffs, and tonal hip logo, as well as the person's face, body shape, pose and background." },
} as const;
type BuiltInGarment = keyof typeof GARMENTS;
type Garment = BuiltInGarment | "custom";
type Stage = "choose" | "survey" | "sign-in" | "upload" | "connecting" | "live" | "finished" | "done";
type PreviewMode = "live" | "photo";
const EMPTY_SURVEY: SurveyAnswers = { answers: {}, other: {} };
type GoogleCredential = { credential: string };
type GoogleIdApi = { initialize: (options: { client_id: string; callback: (response: GoogleCredential) => void }) => void; renderButton: (element: HTMLElement, options: Record<string, string>) => void };
declare global { interface Window { google?: { accounts: { id: GoogleIdApi } } } }

const API = "/api/showroom";
const SESSION_SECONDS = 15;
const CONNECTION_TIMEOUT_MS = 12_000;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
type RealtimeSession = Awaited<ReturnType<ReturnType<typeof createDecartClient>["realtime"]["connect"]>>;
type Availability = { surveyAvailable: boolean; previewAvailable: boolean; googleClientId?: string; survey?: SurveyDefinition };
type Attempt = {
  abort: AbortController;
  credential: string;
  reservationId?: string;
  stream?: MediaStream;
  canvas?: HTMLCanvasElement;
  stopFrames?: () => void;
  session?: RealtimeSession;
  timer?: ReturnType<typeof setTimeout>;
  countdown?: ReturnType<typeof setInterval>;
  endsAt?: number;
  committed: boolean;
  shown: boolean;
};

function post(data: object, signal?: AbortSignal, keepalive = false) {
  return fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    signal,
    keepalive,
  });
}

function LoadingSpinner({ className = "size-4" }: { className?: string }) {
  return <span aria-hidden="true" className={`shrink-0 rounded-full border-2 border-current border-r-transparent motion-safe:animate-spin ${className}`} />;
}

function stopAttempt(attempt: Attempt) {
  attempt.abort.abort();
  clearTimeout(attempt.timer);
  clearInterval(attempt.countdown);
  attempt.stopFrames?.();
  attempt.stream?.getTracks().forEach((track) => track.stop());
  try { attempt.session?.disconnect(); } catch { /* Stop local frames even when the provider is already disconnected. */ }
  if (attempt.canvas) { attempt.canvas.width = 0; attempt.canvas.height = 0; }
}

async function photoStream(photoUrl: string, width: number, height: number, fps: number) {
  // shortcut: repeat one photo for Lucy VTON; replace with a native still-photo model after quality validation.
  const image = new window.Image();
  image.src = photoUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context || !canvas.captureStream) throw new Error("Photo preview is not supported in this browser");
  const scale = Math.min(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight);
  const photoWidth = Math.round(image.naturalWidth * scale);
  const photoHeight = Math.round(image.naturalHeight * scale);
  const draw = () => {
    context.fillStyle = "#15152f";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, (canvas.width - photoWidth) / 2, (canvas.height - photoHeight) / 2, photoWidth, photoHeight);
  };
  draw();
  let frame = requestAnimationFrame(function repeatFrame() { draw(); frame = requestAnimationFrame(repeatFrame); });
  const stream = canvas.captureStream(fps);
  return {
    canvas,
    stream,
    stopFrames: () => cancelAnimationFrame(frame),
  };
}

const SHOWROOM_EASE = [0.21, 0.47, 0.32, 0.98] as const;

const cardVariants: Variants = {
  hidden: {
    opacity: 0,
    y: 28,
    scale: 0.98,
    transition: {
      duration: 0.35,
      ease: SHOWROOM_EASE,
    },
  },
  visible: (custom?: { delay?: number; shouldReduceMotion?: boolean | null }) => ({
    opacity: 1,
    y: 0,
    scale: 1,
    transition: custom?.shouldReduceMotion
      ? { duration: 0 }
      : {
          duration: 0.6,
          delay: custom?.delay ?? 0,
          ease: SHOWROOM_EASE,
        },
  }),
};

export function LiveTryOn() {
  const shouldReduceMotion = useReducedMotion();
  const [availability, setAvailability] = useState<Availability | null>(null);
  const [stage, setStage] = useState<Stage>("choose");
  const [mode, setMode] = useState<PreviewMode>("live");
  const [garment, setGarment] = useState<Garment>("bomber");
  const [customGarment, setCustomGarment] = useState<{ file: File; url: string } | null>(null);
  const [cuttingOut, setCuttingOut] = useState(false);
  const [photo, setPhoto] = useState<{ url: string } | null>(null);
  const [survey, setSurvey] = useState<ReturnType<typeof toSubmission> | null>(null);
  const [surveyDraft, setSurveyDraft] = useState<SurveyAnswers>(EMPTY_SURVEY);
  const [stepError, setStepError] = useState("");
  const [surveyStep, setSurveyStep] = useState(0);
  const [credential, setCredential] = useState("");
  const [message, setMessage] = useState("");
  const [remaining, setRemaining] = useState(SESSION_SECONDS);
  const [saving, setSaving] = useState(false);
  const [signInLoading, setSignInLoading] = useState(false);
  const [connectionLabel, setConnectionLabel] = useState("");
  const [buffering, setBuffering] = useState(false);
  const [consented, setConsented] = useState(false);
  const attemptRef = useRef<Attempt | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const signInButton = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLHeadingElement>(null);
  const carouselRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(true);

  const updateScrollButtons = useCallback(() => {
    const el = carouselRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 4);
    setCanScrollRight(el.scrollLeft < el.scrollWidth - el.clientWidth - 4);
  }, []);

  useEffect(() => {
    const el = carouselRef.current;
    if (!el) return;
    updateScrollButtons();
    el.addEventListener("scroll", updateScrollButtons, { passive: true });
    window.addEventListener("resize", updateScrollButtons);
    return () => {
      el.removeEventListener("scroll", updateScrollButtons);
      window.removeEventListener("resize", updateScrollButtons);
    };
  }, [updateScrollButtons]);

  const scrollCarousel = (direction: "left" | "right") => {
    const el = carouselRef.current;
    if (!el) return;
    const scrollStep = el.clientWidth * 0.75;
    el.scrollBy({
      left: direction === "left" ? -scrollStep : scrollStep,
      behavior: "smooth",
    });
  };

  const selectGarment = (id: BuiltInGarment) => {
    setGarment(id);
    cardRefs.current[id]?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "center",
    });
  };

  useEffect(() => {
    const controller = new AbortController();
    fetch(API, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (response.ok && !controller.signal.aborted) setAvailability(await response.json());
        else if (!controller.signal.aborted) setAvailability({ surveyAvailable: false, previewAvailable: false });
      })
      .catch(() => { if (!controller.signal.aborted) setAvailability({ surveyAvailable: false, previewAvailable: false }); });
    return () => controller.abort();
  }, []);

  useEffect(() => () => { if (photo) URL.revokeObjectURL(photo.url); }, [photo]);
  useEffect(() => () => { if (customGarment) URL.revokeObjectURL(customGarment.url); }, [customGarment]);

  const selectedGarment = garment === "custom" && customGarment
    ? { name: "Upload only", displayName: ["UPLOAD", "ONLY"], image: customGarment.url, prompt: "Dress the person in the garment shown in the reference image. Preserve the garment's visible colors, pattern and details, and preserve the person's face, body shape, pose and background." }
    : GARMENTS[garment === "custom" ? "bomber" : garment];

  const release = useCallback((attempt: Attempt) => {
    if (!attempt.committed && attempt.reservationId) {
      void post({ action: "release", credential: attempt.credential, reservationId: attempt.reservationId }, undefined, true).catch(() => undefined);
    }
  }, []);

  const finish = useCallback((note = "") => {
    const attempt = attemptRef.current;
    if (!attempt) return;
    attemptRef.current = null;
    release(attempt);
    stopAttempt(attempt);
    if (video.current) video.current.srcObject = null;
    setMessage(note);
    setCredential(attempt.committed ? "" : attempt.credential);
    if (attempt.committed) {
      setPhoto(null);
      setCustomGarment(null);
      setGarment("bomber");
      setConsented(false);
      setStage("finished");
    } else {
      setStage("upload");
    }
  }, [release]);

  useEffect(() => {
    function closeWhenHidden() {
      if (document.visibilityState === "hidden") finish("The preview stopped when you left this page.");
    }
    document.addEventListener("visibilitychange", closeWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", closeWhenHidden);
      const attempt = attemptRef.current;
      attemptRef.current = null;
      if (attempt) { release(attempt); stopAttempt(attempt); }
    };
  }, [finish, release]);

  useEffect(() => {
    if (stage === "sign-in" || stage === "upload" || stage === "finished" || stage === "done") status.current?.focus();
  }, [stage]);

  const recordSurvey = useCallback(async (token: string) => {
    if (!survey) return;
    setSaving(true);
    setMessage("");
    try {
      const response = await post({ action: "survey", credential: token, ...survey });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The survey could not be saved.");
      setCredential(token);
      if (result.alreadyUsed) {
        setMessage("Your answers were saved. This Google account can try again one hour after its last preview started.");
        setStage("done");
      } else if (!result.previewAvailable) {
        setMessage("Your answers were saved. The photo try-on is being prepared and is not available yet.");
        setStage("done");
      } else {
        setStage("upload");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The survey could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }, [survey]);

  function initializeGoogleSignIn() {
    setSignInLoading(false);
    const clientId = availability?.googleClientId;
    if (!clientId || !signInButton.current || !window.google) {
      setMessage("Google sign-in is unavailable. Reload the page and try again.");
      return;
    }
    signInButton.current.replaceChildren();
    window.google.accounts.id.initialize({ client_id: clientId, callback: (result) => { if (result.credential) void recordSurvey(result.credential); } });
    window.google.accounts.id.renderButton(signInButton.current, { type: "standard", theme: "outline", size: "large", text: "continue_with", shape: "rectangular", width: "320" });
  }

  function submitSurvey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const definition = availability?.survey;
    if (!definition) return;
    const question = definition.questions[surveyStep];
    const problem = question ? stepProblem(question, surveyDraft) : "";
    setStepError(problem);
    if (problem) return;
    if (surveyStep < definition.questions.length - 1) {
      setSurveyStep((step) => step + 1);
      return;
    }
    setSurvey(toSubmission(definition, surveyDraft));
    setMessage("");
    setSignInLoading(Boolean(availability?.googleClientId));
    setStage("sign-in");
  }

  function startSurvey(nextMode: PreviewMode) {
    setMode(nextMode);
    setSurveyDraft(EMPTY_SURVEY);
    setStepError("");
    setSurveyStep(0);
    setMessage("");
    setStage("survey");
  }

  function choosePhoto(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    setMessage("");
    if (!file) return;
    if (!PHOTO_TYPES.has(file.type) || file.size > MAX_PHOTO_BYTES) {
      setPhoto(null);
      setMessage("Choose a JPG, PNG, or WebP photo up to 10 MB.");
      return;
    }
    setPhoto({ url: URL.createObjectURL(file) });
  }

  async function chooseGarment(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    setMessage("");
    if (!file) return;
    if (!PHOTO_TYPES.has(file.type) || file.size > MAX_PHOTO_BYTES) {
      setMessage("Choose a JPG, PNG, or WebP garment image up to 10 MB.");
      return;
    }
    setCuttingOut(true);
    try {
      // The garment is cut out of its background here, in this browser, so the reference
      // image sent to Decart is the garment alone, like the built-in ones.
      const cutout = await removeGarmentBackground(file);
      setCustomGarment({ file: cutout.file, url: URL.createObjectURL(cutout.file) });
      setGarment("custom");
      if (!cutout.removed) setMessage("This image already had a transparent background, so it was used as is.");
    } catch (error) {
      setMessage(error instanceof GarmentCutoutError ? error.message : "This garment image could not be prepared. Try another image.");
    } finally {
      setCuttingOut(false);
    }
  }

  async function showFirstFrame() {
    const attempt = attemptRef.current;
    if (!attempt || attempt.shown || !attempt.reservationId) return;
    attempt.shown = true;
    clearTimeout(attempt.timer);
    try {
      if (!(await post({ action: "commit", credential: attempt.credential, reservationId: attempt.reservationId }, attempt.abort.signal)).ok) {
        finish("The try-on could not be secured. Your try has been restored.");
        return;
      }
      attempt.committed = true;
      attempt.endsAt = Date.now() + SESSION_SECONDS * 1000;
      setStage("live");
      const updateCountdown = () => setRemaining(Math.max(0, Math.ceil(((attempt.endsAt ?? Date.now()) - Date.now()) / 1000)));
      updateCountdown();
      attempt.countdown = setInterval(updateCountdown, 250);
      attempt.timer = setTimeout(() => finish(), SESSION_SECONDS * 1000);
    } catch {
      finish("The try-on could not be secured. Your try has been restored.");
    }
  }

  async function start() {
    if ((mode === "photo" && !photo) || (garment === "custom" && !customGarment) || cuttingOut || !credential || !consented || !availability?.previewAvailable || attemptRef.current) return;
    const attempt: Attempt = { abort: new AbortController(), credential, committed: false, shown: false };
    attemptRef.current = attempt;
    setMessage("");
    setRemaining(SESSION_SECONDS);
    setBuffering(false);
    setConnectionLabel(mode === "photo" ? "Preparing your photo…" : "Opening your camera…");
    setStage("connecting");
    try {
      const { createDecartClient, models, noopLogger, resolveFpsNumber } = await import("@decartai/sdk");
      const model = models.realtime("lucy-vton-3.6");
      let stream: MediaStream;
      if (mode === "photo" && photo) {
        const source = await photoStream(photo.url, model.width, model.height, resolveFpsNumber(model.fps));
        if (attemptRef.current !== attempt) { source.stream.getTracks().forEach((track) => track.stop()); source.stopFrames(); source.canvas.width = 0; return; }
        attempt.canvas = source.canvas;
        attempt.stopFrames = source.stopFrames;
        stream = source.stream;
      } else {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access needs a supported browser on a secure connection.");
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: model.width }, height: { ideal: model.height }, frameRate: model.fps },
          audio: false,
        });
        if (attemptRef.current !== attempt) { stream.getTracks().forEach((track) => track.stop()); return; }
        stream.getVideoTracks().forEach((track) => track.addEventListener("ended", () => {
          if (attemptRef.current === attempt) finish("Your camera disconnected.");
        }, { once: true }));
      }
      if (attemptRef.current !== attempt) { stream.getTracks().forEach((track) => track.stop()); return; }
      attempt.stream = stream;
      setConnectionLabel("Connecting your preview…");

      const image = garment === "custom" && customGarment
        ? customGarment.file
        : await fetch(GARMENTS[garment === "custom" ? "bomber" : garment].image, { signal: attempt.abort.signal }).then((response) => {
          if (!response.ok) throw new Error("Garment unavailable");
          return response.blob();
        });
      const response = await post({ action: "start", credential, garment, consent: true }, attempt.abort.signal);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "The live preview is not available right now.");
      attempt.reservationId = result.reservationId;
      attempt.timer = setTimeout(() => finish("The photo preview could not start. Your try has been restored."), CONNECTION_TIMEOUT_MS);

      let token = typeof result.apiKey === "string" ? result.apiKey : "";
      const client = createDecartClient({
        telemetry: false,
        logger: noopLogger,
        apiKeyProvider: async () => {
          if (!token || attemptRef.current !== attempt) throw new Error("The one-use preview token is no longer available");
          const key = token;
          token = "";
          return key;
        },
      });
      const session = await client.realtime.connect(stream, {
        model,
        retries: 0,
        capacityRetryBudgetMs: 0,
        mirror: false,
        initialState: {
          image,
          prompt: { text: selectedGarment.prompt, enhance: false },
          passthrough: false,
        },
        onRemoteStream: (remote) => {
          if (attemptRef.current !== attempt || !video.current) return;
          video.current.srcObject = remote;
          if (!attempt.shown) setConnectionLabel("Waiting for your try-on video…");
        },
        onConnectionChange: (state) => {
          if (attemptRef.current === attempt && (state === "reconnecting" || state === "disconnected")) {
            finish(attempt.shown ? "The preview connection ended early." : "The photo preview could not start. Your try has been restored.");
          }
        },
      });
      if (attemptRef.current !== attempt) { session.disconnect(); return; }
      attempt.session = session;
      session.on("sessionEnded", () => { if (attemptRef.current === attempt) finish(); });
      session.on("error", () => { if (attemptRef.current === attempt) finish("The preview was interrupted."); });
    } catch (error) {
      if (attemptRef.current !== attempt) return;
      finish(error instanceof Error ? `${error.message} Your try has been restored.` : "The photo preview could not start. Your try has been restored.");
    }
  }

  const surveyUnavailable = availability !== null && (!availability.surveyAvailable || !availability.survey);
  const definition = availability?.survey;
  const stepCount = Math.max(1, definition?.questions.length ?? 1);
  const lastStep = surveyStep >= stepCount - 1;
  const previewUnavailable = availability !== null && !availability.previewAvailable;
  const previewLoading = stage === "connecting" ? connectionLabel : stage === "live" && buffering ? "Buffering your preview…" : "";

  const isLiveSession = stage === "live" || stage === "connecting";

  return (
    <div>
      <div className="grid gap-6 sm:gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] lg:items-stretch xl:gap-12">
        {/* Left Column: Showroom View */}
        <motion.div
          variants={cardVariants}
          custom={{ delay: 0, shouldReduceMotion }}
          initial={isLiveSession ? "visible" : "hidden"}
          whileInView={isLiveSession ? undefined : "visible"}
          animate={isLiveSession ? "visible" : undefined}
          viewport={{ once: false, margin: "-60px" }}
          className="relative isolate aspect-[4/3] min-h-[280px] sm:min-h-[380px] lg:aspect-auto lg:min-h-0 w-full overflow-hidden rounded-md bg-[#15152f] text-white shadow-xl will-change-[transform,opacity]"
        >
          <span aria-hidden="true" className="viewfinder-bracket viewfinder-top-left text-white/50" />
          <span aria-hidden="true" className="viewfinder-bracket viewfinder-top-right text-white/50" />
          <span aria-hidden="true" className="viewfinder-bracket viewfinder-bottom-left text-white/50" />
          <span aria-hidden="true" className="viewfinder-bracket viewfinder-bottom-right text-white/50" />
          {photo && stage !== "done" && (
            <Image
              src={photo.url}
              alt="Your selected body photo, held in this page for preview"
              fill
              sizes="(max-width: 1023px) 100vw, 800px"
              unoptimized
              className={`object-contain ${stage === "live" ? "opacity-0" : ""}`}
            />
          )}
          {!photo && stage !== "live" && (
            <>
              <div
                aria-hidden="true"
                className={`absolute inset-x-0 top-1/2 -translate-y-1/2 z-0 px-3 text-center font-black italic uppercase leading-[0.82] text-white/15 select-none pointer-events-none ${
                  garment === "shirt" || garment === "cardigan"
                    ? "text-[clamp(2.1rem,6.2vw,4.5rem)] tracking-[-0.06em]"
                    : "text-[clamp(2.5rem,7.5vw,5.5rem)] tracking-[-0.055em]"
                }`}
              >
                <span className="block">{garment === "custom" ? "UPLOAD" : selectedGarment.displayName[0]}</span>
                <span className="block">{garment === "custom" ? "ONLY" : selectedGarment.displayName[1]}</span>
              </div>
              <Image
                src={selectedGarment.image}
                alt={`${selectedGarment.name}, illustrative fashion concept`}
                fill
                sizes="(max-width: 1023px) 100vw, 800px"
                unoptimized={garment === "custom"}
                className="z-10 object-contain p-6 sm:p-8 drop-shadow-[0_20px_35px_rgba(0,0,0,0.45)]"
              />
              <div className="absolute bottom-3.5 left-4 z-20 text-left pointer-events-none sm:bottom-4 sm:left-5">
                <p className="font-semibold tracking-tight text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.85)]">{selectedGarment.name}</p>
                <p className="text-xs text-white/75 drop-shadow-[0_1px_4px_rgba(0,0,0,0.85)]">{garment === "custom" ? "Uploaded garment, background removed" : "Illustrative garment preview"}</p>
              </div>
            </>
          )}
          <video
            ref={video}
            autoPlay
            muted
            playsInline
            onWaiting={() => { if (stage === "live") setBuffering(true); }}
            onPlaying={() => { setBuffering(false); void showFirstFrame(); }}
            aria-label="15-second AI-generated virtual try-on preview"
            aria-hidden={stage !== "live"}
            className={`absolute inset-0 size-full object-contain ${stage === "live" ? "" : "opacity-0"}`}
          />
          <div role="status" className={previewLoading ? "absolute inset-0 z-30 grid place-items-center bg-[#15152f]/90 px-4 text-center" : "sr-only"}>
            {previewLoading && (
              <div className="grid justify-items-center gap-3">
                <LoadingSpinner className="size-9 text-[#99b0ff]" />
                <p className="text-sm font-semibold sm:text-base">{previewLoading}</p>
              </div>
            )}
          </div>
          {stage === "live" && (
            <div className="absolute inset-x-0 bottom-0 flex justify-between gap-3 bg-[#15152f] px-4 py-2 text-sm">
              <span>AI style preview</span><span className="tabular-nums">{remaining}s left</span>
            </div>
          )}
        </motion.div>

        {/* Right Column: Controls Container */}
        <motion.div
          variants={cardVariants}
          custom={{ delay: 0.12, shouldReduceMotion }}
          initial={isLiveSession ? "visible" : "hidden"}
          whileInView={isLiveSession ? undefined : "visible"}
          animate={isLiveSession ? "visible" : undefined}
          viewport={{ once: false, margin: "-60px" }}
          className="flex flex-col justify-between rounded-md border border-[#d5d5e4] bg-[#fcfcff] p-5 sm:p-6 shadow-sm will-change-[transform,opacity]"
        >
          {(stage === "choose" || stage === "survey") && (
            <div className="flex h-full flex-col justify-between gap-4">
              <div className="space-y-1">
                <h3 className="text-xl sm:text-2xl font-bold tracking-tight text-[#101b43]">Select your look</h3>
                <p className="text-xs sm:text-sm leading-relaxed text-[#51516c]">
                  Choose a Floating Brand piece or upload your own garment. Previews run for 15 seconds.
                </p>
              </div>

              {/* Garments Carousel with Left/Right Buttons */}
              <div className="space-y-2">
                <div className="flex items-center gap-1.5 sm:gap-2">
                  <button
                    type="button"
                    onClick={() => scrollCarousel("left")}
                    disabled={!canScrollLeft}
                    aria-label="Previous garments"
                    className="inline-flex size-7 sm:size-8 shrink-0 items-center justify-center rounded-full border border-[#d5d5e4] bg-white text-[#101b43] shadow-xs transition-all hover:border-[#101b43] hover:bg-[#f0f2fa] disabled:opacity-25 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:border-[#d5d5e4] focus-visible:outline-2 focus-visible:outline-[#0038ff]"
                  >
                    <ChevronLeft className="size-4" />
                  </button>

                  <div
                    ref={carouselRef}
                    role="group"
                    aria-label="Choose a garment"
                    className="flex flex-1 gap-2.5 sm:gap-3 overflow-x-auto no-scrollbar scroll-smooth snap-x snap-mandatory py-1 px-0.5"
                  >
                    {(Object.entries(GARMENTS) as [BuiltInGarment, typeof GARMENTS[BuiltInGarment]][]).map(([id, item]) => {
                      const isSelected = garment === id;
                      return (
                        <button
                          key={id}
                          ref={(el) => { cardRefs.current[id] = el; }}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => selectGarment(id)}
                          className={`group relative w-[136px] sm:w-[152px] shrink-0 aspect-[1.32/1] sm:aspect-[1.36/1] snap-start overflow-hidden rounded border text-left transition-all duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0038ff] ${
                            isSelected
                              ? "border-[#0038ff] bg-[#1a1c3d] shadow-[0_0_20px_rgba(0,56,255,0.25)] ring-2 ring-[#0038ff]"
                              : "border-[#2b2b52] bg-[#12132a] hover:border-[#4b5182] hover:bg-[#161734]"
                          }`}
                        >
                          <span
                            aria-hidden="true"
                            className={`absolute inset-x-0 top-1/2 z-0 -translate-y-1/2 text-center text-[clamp(0.65rem,1.1vw,0.85rem)] font-black italic uppercase leading-[0.88] tracking-[-0.04em] transition-colors select-none ${
                              isSelected ? "text-white/35" : "text-white/15 group-hover:text-white/25"
                            }`}
                          >
                            <span className="block">{item.displayName[0]}</span>
                            <span className="block">{item.displayName[1]}</span>
                          </span>
                          <Image
                            src={item.image}
                            alt=""
                            fill
                            sizes="(max-width: 640px) 140px, 160px"
                            className="z-10 object-contain p-2 transition-transform duration-300 ease-out group-hover:scale-105 drop-shadow-[0_4px_12px_rgba(0,0,0,0.5)]"
                          />
                          <div
                            className={`absolute inset-x-0 bottom-0 z-20 border-t border-white/10 px-2 py-1 transition-colors ${
                              isSelected ? "bg-[#0b0c23]/95" : "bg-[#0b0c23]/90 group-hover:bg-[#0b0c23]"
                            }`}
                          >
                            <span className="block truncate text-[0.68rem] sm:text-xs font-semibold tracking-tight text-white/95">
                              {item.name}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  <button
                    type="button"
                    onClick={() => scrollCarousel("right")}
                    disabled={!canScrollRight}
                    aria-label="Next garments"
                    className="inline-flex size-7 sm:size-8 shrink-0 items-center justify-center rounded-full border border-[#d5d5e4] bg-white text-[#101b43] shadow-xs transition-all hover:border-[#101b43] hover:bg-[#f0f2fa] disabled:opacity-25 disabled:cursor-not-allowed disabled:hover:bg-white disabled:hover:border-[#d5d5e4] focus-visible:outline-2 focus-visible:outline-[#0038ff]"
                  >
                    <ChevronRight className="size-4" />
                  </button>
                </div>

                {/* Carousel Indicator Dots */}
                <div className="flex justify-center items-center gap-1.5 pt-1">
                  {(Object.keys(GARMENTS) as BuiltInGarment[]).map((id) => (
                    <button
                      key={id}
                      type="button"
                      aria-label={`Select ${GARMENTS[id].name}`}
                      onClick={() => selectGarment(id)}
                      className={`h-1.5 rounded-full transition-all duration-300 ${
                        garment === id ? "w-6 bg-[#0038ff]" : "w-1.5 bg-[#d5d5e4] hover:bg-[#a3acd2]"
                      }`}
                    />
                  ))}
                </div>
              </div>

              <div
                className={`rounded border p-2.5 transition-all duration-200 ${
                  garment === "custom" && customGarment
                    ? "border-[#0038ff] bg-[#1a1c3d] text-white shadow-[0_0_16px_rgba(0,56,255,0.2)] ring-1 ring-[#0038ff]"
                    : "border-[#d5d5e4] bg-[#f4f5fa] text-[#101b43] hover:border-[#a3acd2]"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    disabled={!customGarment}
                    onClick={() => customGarment && setGarment("custom")}
                    className={`min-w-0 flex-1 text-left ${!customGarment ? "cursor-default" : "cursor-pointer"}`}
                  >
                    <p className="text-xs font-bold uppercase tracking-wider text-[#0038ff]">
                      Custom Garment
                    </p>
                    <p className={`mt-0.5 truncate text-xs ${garment === "custom" && customGarment ? "text-white/80" : "text-[#51516c]"}`}>
                      {customGarment ? "Uploaded garment cutout active" : "Upload your own JPG, PNG, or WebP (up to 10 MB)"}
                    </p>
                  </button>
                  <label className="relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded border border-[#101b43] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#101b43] transition-colors hover:bg-[#101b43] hover:text-white focus-within:ring-2 focus-within:ring-[#0038ff]">
                    <Upload className="mr-1.5 size-3.5" />
                    <span>{customGarment ? "Change" : "Upload"}</span>
                    <input
                      type="file"
                      accept="image/jpeg,image/png,image/webp"
                      onClick={prepareGarmentCutout}
                      onChange={chooseGarment}
                      disabled={cuttingOut}
                      className="sr-only"
                    />
                  </label>
                </div>
                {cuttingOut && (
                  <p role="status" className="mt-2 flex items-center gap-2 text-xs text-[#51516c] dark:text-white/70">
                    <LoadingSpinner className="size-3.5 text-[#0038ff]" />
                    Removing garment background on your device…
                  </p>
                )}
              </div>

              <div className="space-y-2 pt-2.5 border-t border-[#d5d5e4]">
                <button
                  type="button"
                  onClick={() => startSurvey("live")}
                  className="editorial-action w-full justify-between text-left"
                >
                  <span className="flex items-center gap-2">
                    <Camera className="size-4 shrink-0" />
                    <span>Live camera preview</span>
                  </span>
                  <ArrowRight className="size-4 shrink-0" />
                </button>
                {stage === "choose" && availability === null && (
                  <p role="status" className="flex items-center gap-2 text-xs text-[#51516c]">
                    <LoadingSpinner className="size-3.5" />Checking preview availability…
                  </p>
                )}
                {availability && !availability.previewAvailable && (
                  <p role="status" className="text-xs text-[#51516c]">
                    Preview setup is not ready yet. Previews will unlock once integrations and provider approval are complete.
                  </p>
                )}
              </div>
            </div>
          )}

          {stage === "sign-in" && (
            <div className="space-y-4">
              <h3 ref={status} tabIndex={-1} className="text-2xl font-bold tracking-tight">Save your answers</h3>
              <p className="text-sm text-[#51516c]">Sign in with Google. FitCheck uses your verified Google email to allow one try-on per hour; it is not stored with your answers.</p>
              {availability?.googleClientId && <Script src="https://accounts.google.com/gsi/client" strategy="afterInteractive" onReady={initializeGoogleSignIn}
                onError={() => { setSignInLoading(false); setMessage("Google sign-in is unavailable. Reload the page and try again."); }} />}
              <div ref={signInButton} aria-label="Continue with Google" hidden={saving} />
              {(saving || signInLoading) && <p role="status" className="flex items-center gap-2 text-sm text-[#51516c]"><LoadingSpinner />{saving ? "Saving your answers…" : "Loading Google sign-in…"}</p>}
              {availability?.googleClientId && !saving && !signInLoading && <p className="text-xs text-[#51516c]">Only Gmail or Google Workspace accounts with a verified email can use a preview.</p>}
              <button type="button" disabled={saving} onClick={() => { setMessage(""); setStage("survey"); }} className="min-h-11 underline underline-offset-4 disabled:opacity-60">Edit answers</button>
            </div>
          )}

          {stage === "upload" && (
            <div className="space-y-4">
              <h3 ref={status} tabIndex={-1} className="text-2xl font-bold tracking-tight">{mode === "photo" ? "Choose your photo and look" : "Choose your look"}</h3>
              {mode === "photo" ? <>
                <p className="text-sm text-[#51516c]">Use a clear, front-facing photo with the person’s upper body visible. JPG, PNG, or WebP up to 10 MB.</p>
                <label className="block text-sm font-semibold">Body photo
                  <input type="file" accept="image/jpeg,image/png,image/webp" onChange={choosePhoto} className="mt-2 block w-full text-sm file:mr-3 file:min-h-11 file:border-0 file:bg-[#0038ff] file:px-4 file:font-semibold file:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0038ff]" />
                </label>
              </> : <p className="text-sm text-[#51516c]">Your camera turns on only after you agree and start the preview. Audio stays off.</p>}
              <p id="showroom-photo-consent" className="text-sm leading-relaxed text-[#51516c]">
                {mode === "photo" ? "Your photo and the selected garment image are streamed from your browser to Decart to generate the preview. FitCheck does not save either image or the generated video. The preview, photo and uploaded garment image are cleared from this page when you stop, finish, or close it." : "Your camera video and the selected garment image are streamed from your browser to Decart to generate the preview. FitCheck does not save the video or generated result. The camera and uploaded garment image are cleared when you stop, finish, or close the page."} Decart’s handling follows its provider terms; public use stays disabled until those terms are approved.
              </p>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} aria-describedby="showroom-photo-consent" className="mt-0.5 size-4 shrink-0 accent-[#0038ff]" />
                I’m 18 or older and agree to send {mode === "photo" ? "this photo" : "my camera video"} and the selected garment image to Decart for a 15-second style preview.
              </label>
              <div className="flex flex-wrap gap-3">
                <button type="button" onClick={() => void start()} disabled={(mode === "photo" && !photo) || (garment === "custom" && !customGarment) || cuttingOut || !consented || saving || previewUnavailable} className="editorial-action disabled:cursor-not-allowed disabled:opacity-60">Start 15-second try-on</button>
                {photo && <button type="button" onClick={() => { setPhoto(null); setConsented(false); setMessage(""); }} className="min-h-11 underline underline-offset-4">Remove photo</button>}
              </div>
              <button type="button" onClick={() => { setStage("choose"); setPhoto(null); setConsented(false); setMessage(""); }} className="min-h-11 underline underline-offset-4">Choose a different preview</button>
              {previewUnavailable && <p role="status" className="text-sm text-[#51516c]">Try-on previews are not enabled yet. They will stay unavailable until provider approval and setup are complete.</p>}
            </div>
          )}

          {(stage === "connecting" || stage === "live") && (
            <div className="space-y-4">
              <h3 className="text-2xl font-bold">{stage === "live" ? "Your look, in motion" : "Starting your try-on"}</h3>
              <p className="text-sm text-[#51516c]">{stage === "live" ? "Your preview ends after 15 seconds." : "Keep this page open while the preview connects."}</p>
              <button type="button" onClick={() => finish()} className="editorial-action">{stage === "live" ? "Stop preview" : "Cancel preview"}</button>
            </div>
          )}

          {(stage === "finished" || stage === "done") && <h3 ref={status} tabIndex={-1} className="text-2xl font-bold tracking-tight">Thanks for taking part.</h3>}
          {message && <p role="status" className="mt-4 text-sm text-[#51516c]">{message}</p>}
          {stage === "finished" && (
            <div className="mt-5 w-fit max-w-full space-y-2 bg-[#101b43] px-4 py-3 text-white">
              <h4 className="text-sm font-semibold">Follow us</h4>
              <SocialLinks />
            </div>
          )}
        </motion.div>
      </div>

      {stage === "survey" && (
        <Dialog open onOpenChange={(open) => { if (!open) setStage("choose"); }}>
          <DialogContent
            style={{ display: "flex", flexDirection: "column", maxHeight: "calc(100dvh - 2rem)" }}
            className="w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] gap-4 overflow-y-auto rounded-none border border-[#a3acd2] bg-white p-5 text-[#101b43] sm:max-w-2xl sm:p-8"
          >
            <DialogTitle className="pr-8 text-xl sm:text-2xl font-bold tracking-tight">{definition?.title ?? "FitCheck Market Validation Survey"}</DialogTitle>
            <DialogDescription className="text-sm text-[#51516c]">{definition?.intro || "One quick question at a time. Your answers are saved privately to FitCheck after Google sign-in."}</DialogDescription>
            <div role="progressbar" aria-label="Survey progress" aria-valuemin={1} aria-valuemax={stepCount} aria-valuenow={surveyStep + 1} className="h-1.5 w-full bg-[#e8ebf6]">
              <div className="h-full bg-[#0038ff] transition-[width]" style={{ width: `${((surveyStep + 1) / stepCount) * 100}%` }} />
            </div>
            <p className="text-xs font-semibold uppercase tracking-wide text-[#51516c]">Step {surveyStep + 1} of {stepCount}</p>
            <form onSubmit={submitSurvey} className="flex min-h-0 flex-col gap-5">
              <div className="min-h-[10rem] flex-1 space-y-4">
                {availability === null && <p role="status" className="flex items-center gap-2 text-sm text-[#51516c]"><LoadingSpinner />Loading the questions…</p>}
                {definition?.questions[surveyStep] && (
                  <SurveyQuestionField key={definition.questions[surveyStep].id} question={definition.questions[surveyStep]} value={surveyDraft} onChange={(next) => { setSurveyDraft(next); setStepError(""); }} />
                )}
                {stepError && <p role="alert" className="text-sm text-[#b42318]">{stepError}</p>}
              </div>
              {surveyUnavailable && <p role="status" className="text-sm text-[#51516c]">The survey isn’t available right now, so answers cannot be submitted.</p>}
              <div className="flex items-center justify-between gap-3">
                <button type="button" onClick={() => surveyStep === 0 ? setStage("choose") : setSurveyStep((step) => step - 1)} className="min-h-11 underline underline-offset-4">{surveyStep === 0 ? "Back to preview" : "Back"}</button>
                <button type="submit" disabled={saving || !definition || (lastStep && (availability === null || surveyUnavailable))} className="editorial-action disabled:cursor-not-allowed disabled:opacity-60">
                  {availability === null && <LoadingSpinner />}
                  {!lastStep ? "Continue" : availability === null ? "Checking setup…" : surveyUnavailable ? "Survey unavailable" : "Continue to Google sign-in"}
                </button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
