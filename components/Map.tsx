"use client";

import dynamic from "next/dynamic";

// MapLibre needs the browser (WebGL, workers), so never render it on the server.
export const Map = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="map" aria-hidden="true" />,
});
