"use client";

import { LiveTryOn } from "./showroom/LiveTryOn";
import { ScrollHeading, ScrollText } from "./ScrollReveal";

export function InteractiveShowroom() {
  return (
    <section
      id="scene-showroom"
      aria-labelledby="showroom-title"
      className="editorial-section scroll-mt-8 text-[#101b43]"
    >
      <div className="border-b border-[#d5d5e4] pb-6 text-center">
        <ScrollHeading margin="-80px" className="w-full">
          <h2
            id="showroom-title"
            className="w-full text-center text-balance font-black italic uppercase tracking-[-0.045em] text-4xl sm:text-6xl text-[#101b43]"
          >
            Explore the showroom.
          </h2>
        </ScrollHeading>
        <ScrollText delay={0.08} margin="-80px">
          <p className="mt-3 text-center text-xs sm:text-sm font-medium text-[#51516c]">
            Visual style preview only. Sizing and drape vary; check the seller’s size chart for fit.
          </p>
        </ScrollText>
      </div>

      <div className="mt-8">
        <LiveTryOn />
      </div>
    </section>
  );
}
