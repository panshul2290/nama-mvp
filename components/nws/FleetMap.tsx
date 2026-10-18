"use client";

import dynamic from "next/dynamic";

// MapLibre needs the browser (WebGL, workers), so never render it on the server.
export const FleetMap = dynamic(() => import("./FleetMapView"), { ssr: false, loading: () => <div className="mapfill" aria-hidden="true" /> });
