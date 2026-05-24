import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';
import * as topojson from "https://cdn.jsdelivr.net/npm/topojson-client@3/+esm";
import scrollama from 'https://cdn.jsdelivr.net/npm/scrollama@3.2.0/+esm';

/* ============================================ */
/*  DATA · coral reef regions                    */
/* ============================================ */

// Major coral reef regions with approximate centroids.
// (based on WCMC global reef distribution data)
const REEF_LOCATIONS = [
    { name: "Great Barrier Reef", lat: -18.2, lon: 147.7, size: 9 },
    { name: "Coral Triangle", lat: -1.0, lon: 130.0, size: 9 },
    { name: "Mesoamerican Reef", lat: 17.5, lon: -87.5, size: 7 },
    { name: "Red Sea", lat: 22.0, lon: 38.0, size: 6 },
    { name: "Maldives", lat: 3.2, lon: 73.2, size: 6 },
    { name: "Caribbean", lat: 18.0, lon: -75.0, size: 7 },
    { name: "Hawaiian Islands", lat: 20.8, lon: -156.5, size: 5 },
    { name: "Philippines", lat: 12.0, lon: 122.0, size: 7 },
    { name: "Fiji & South Pacific", lat: -17.0, lon: 179.0, size: 6 },
    { name: "East Africa", lat: -8.0, lon: 40.0, size: 5 },
    { name: "Florida Keys", lat: 24.6, lon: -81.5, size: 5 },
    { name: "French Polynesia", lat: -17.5, lon: -149.5, size: 5 },
    { name: "Andaman Sea", lat: 8.0, lon: 98.0, size: 5 },
    { name: "Galápagos", lat: -0.5, lon: -90.5, size: 4 },
    { name: "Persian Gulf", lat: 26.5, lon: 52.0, size: 4 },
];

// Great Barrier Reef bounding box (approximate)
// Used for the brush animation and the zoom target
const GBR_BBOX = {
    lonMin: 142,
    lonMax: 154,
    latMin: -24.5,
    latMax: -10,
};

// Uniformly pad GBR_BBOX outward so the view bbox has the same aspect
// ratio as the brush but slightly larger — creates even margins
const VIEW_PADDING = 0.05;  // 10% padding on each side
const padW = (GBR_BBOX.lonMax - GBR_BBOX.lonMin) * VIEW_PADDING;
const padH = (GBR_BBOX.latMax - GBR_BBOX.latMin) * VIEW_PADDING;
const GBR_VIEW_BBOX = {
    lonMin: GBR_BBOX.lonMin - padW,
    lonMax: GBR_BBOX.lonMax + padW,
    latMin: GBR_BBOX.latMin - padH,
    latMax: GBR_BBOX.latMax + padH,
};

/* ============================================ */
/*  SECTION 2 · SST DATA STATE                   */
/* ============================================ */

let sstState = {
    metadata: null,
    currentYear: 2003,
    mode: "sst",
    imageLoaded: false,
    autoAnimationId: null,
    autoAnimationDone: false,
    pixelData: null,
    pixelDataKey: null, 
};

async function loadSSTMetadata() {
    try {
        console.log("Loading SST metadata from docs/modis_data/sst_metadata.json ...");
        sstState.metadata = await d3.json("docs/modis_data/sst_metadata.json");
        console.log("SST metadata loaded:", sstState.metadata);
    } catch (err) {
        console.error("Failed to load SST metadata:", err);
        console.error("Tried URL:", new URL("docs/modis_data/sst_metadata.json", window.location.href).href);
    }
}

/* ============================================ */
/*  SCROLLAMA SETUP                              */
/* ============================================ */

function initScrollytelling() {
    const scroller = scrollama();

    scroller
        .setup({
            step: "#baseline .step",
            offset: 0.5,    // step becomes active when its top crosses 50% viewport
            //   debug: true,  // uncomment to see scrollama's trigger lines
        })
        .onStepEnter((response) => {
            console.log("Step entered:", response.element.dataset.step);
            response.element.classList.add("is-active");
            const stepIdx = +response.element.dataset.step;
            mapTransitionTo(stepIdx);
        })
        .onStepExit((response) => {
            response.element.classList.remove("is-active");
        });

    window.addEventListener("resize", () => scroller.resize());
}

/* ============================================ */
/*  DIVE OVERLAY · scroll-driven bubble rush     */
/* ============================================ */

const diveOverlay = document.getElementById("dive-overlay");
let bubbleSpawnInterval = null;
let activeBubbleCount = 0;

// Create one bubble at a random horizontal position
function spawnBubble() {
    // Cap to keep performance smooth
    if (activeBubbleCount > 350) return;

    const bubble = document.createElement("span");
    bubble.className = "dive-bubble";

    // Random size — mix of tiny and huge for depth
    const size = 6 + Math.random() * 48;
    bubble.style.width = `${size}px`;
    bubble.style.height = `${size}px`;

    // Random horizontal position, full screen width
    bubble.style.left = `${Math.random() * 100}%`;

    // Bigger bubbles travel faster (closer to viewer)
    const duration = 1.5 + (60 / size) * 0.6;  // ~1.5–4s
    bubble.style.animationDuration = `${duration}s`;

    // Slight opacity variation for depth
    bubble.style.opacity = 0.5 + Math.random() * 0.5;

    diveOverlay.appendChild(bubble);
    activeBubbleCount++;

    // Clean up when the animation finishes
    bubble.addEventListener("animationend", () => {
        bubble.remove();
        activeBubbleCount--;
    });
}

// Tie overlay opacity + spawn rate to scroll position.
// Active zone is now anchored to the entire #dive section.
function updateDiveOverlay() {
    const dive = document.getElementById("dive");
    if (!dive) return;

    const diveTop = dive.offsetTop;
    const diveBottom = diveTop + dive.offsetHeight;
    const scrollY = window.scrollY + window.innerHeight / 2;  // middle of viewport

    // Active zone: starts before dive enters, ends after it exits
    const zoneStart = diveTop - window.innerHeight * 0.5;
    const zoneEnd = diveBottom + window.innerHeight * 0.5;
    const zoneMid = (zoneStart + zoneEnd) / 2;
    const halfWidth = (zoneEnd - zoneStart) / 2;

    // Signed distance: negative = before peak, positive = after peak
    const signedDist = (scrollY - zoneMid) / halfWidth;

    // Asymmetric curve: normal ramp-up, sharper ramp-down
    let opacity = 0;
    if (signedDist > -1 && signedDist < 1) {
        if (signedDist <= 0) {
            // Before peak: normal cosine ramp-up
            opacity = Math.cos(Math.abs(signedDist) * Math.PI / 2);
        } else {
            // After peak: faster falloff (raise to a power > 1 to make it drop quicker)
            opacity = Math.pow(Math.cos(signedDist * Math.PI / 2), 3.5);
        }
    }

    diveOverlay.style.opacity = opacity.toFixed(3);

    // Spawn rate scales with opacity
    const shouldSpawn = opacity > 0.03;
    const spawnIntervalMs = shouldSpawn
        ? Math.max(1, 60 - opacity * 55)  // 60ms at edges, 6ms at peak — much denser
        : 999999;

    const bubblesPerTick = Math.max(1, Math.round(opacity * 6));  // 1 at edges, 4 at peak

    const spawnBatch = () => {
        for (let i = 0; i < bubblesPerTick; i++) spawnBubble();
    };

    if (shouldSpawn && !bubbleSpawnInterval) {
        bubbleSpawnInterval = setInterval(spawnBatch, spawnIntervalMs);
    } else if (shouldSpawn && bubbleSpawnInterval) {
        clearInterval(bubbleSpawnInterval);
        bubbleSpawnInterval = setInterval(spawnBatch, spawnIntervalMs);
    } else if (!shouldSpawn && bubbleSpawnInterval) {
        clearInterval(bubbleSpawnInterval);
        bubbleSpawnInterval = null;
    }
}

// Hook into scroll — throttled with rAF for performance
let scrollScheduled = false;
window.addEventListener("scroll", () => {
    if (!scrollScheduled) {
        requestAnimationFrame(() => {
            updateDiveOverlay();
            scrollScheduled = false;
        });
        scrollScheduled = true;
    }
}, { passive: true });

// Initial call so overlay is correct on page load
updateDiveOverlay();

/* ============================================ */
/*  SECTION 2 · WORLD MAP                        */
/* ============================================ */

let mapState = {
    svg: null,
    projection: null,
    path: null,
    width: 0,
    height: 0,
    worldLoaded: false,
};

async function initMap() {
    const stage = document.getElementById("map-stage");
    if (!stage) return;

    const rect = stage.getBoundingClientRect();
    mapState.width = rect.width;
    mapState.height = rect.height;

    // Create the SVG inside #map-stage
    mapState.svg = d3.select(stage).append("svg")
        .attr("viewBox", `0 0 ${mapState.width} ${mapState.height}`)
        .attr("preserveAspectRatio", "xMidYMid slice");

    // Set up the projection — Natural Earth, centered to show Pacific reefs well
    mapState.projection = d3.geoNaturalEarth1()
        .scale(mapState.width / 5.8)
        .translate([mapState.width / 2, mapState.height / 2])
        .center([0, 0]);

    mapState.path = d3.geoPath().projection(mapState.projection);

    // Build the layers (back to front)
    const root = mapState.svg.append("g").attr("class", "map-root");

    // Ocean: a single rect behind everything
    root.append("rect")
        .attr("class", "map-ocean")
        .attr("width", mapState.width)
        .attr("height", mapState.height);

    // Graticule: lat/lon grid lines
    const graticule = d3.geoGraticule().step([20, 20]);
    root.append("path")
        .datum(graticule())
        .attr("class", "map-graticule")
        .attr("d", mapState.path);

    // SST layer — empty placeholder, populated by showSSTBaseline()
    // Sits BELOW the land so coastline covers any data overlap
    root.append("g").attr("class", "sst-layer");

    // Land: loaded asynchronously from a CDN
    try {
        const world = await d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json");
        const landFeatures = topojson.feature(world, world.objects.countries);

        root.append("path")
            .datum(landFeatures)
            .attr("class", "map-land")
            .attr("d", mapState.path);

        mapState.worldLoaded = true;
    } catch (err) {
        console.warn("World topology failed to load:", err);
    }

    // Reef dots — added last so they sit on top
    const reefLayer = root.append("g").attr("class", "reef-layer");

    reefLayer.selectAll(".reef-dot")
        .data(REEF_LOCATIONS)
        .enter()
        .append("circle")
        .attr("class", "reef-dot")
        .attr("cx", d => mapState.projection([d.lon, d.lat])[0])
        .attr("cy", d => mapState.projection([d.lon, d.lat])[1])
        .attr("r", 0)                              // start invisible
        .on("mouseenter", handleReefHover)
        .on("mouseleave", handleReefLeave);

    // Create the tooltip element (just once, reused for all dots)
    d3.select(stage).append("div")
        .attr("class", "reef-tooltip")
        .attr("id", "reef-tooltip");
}

/* ---------- Reef dot interactions ---------- */

function handleReefHover(event, d) {
    const stage = document.getElementById("map-stage");
    const tooltip = document.getElementById("reef-tooltip");
    const stageRect = stage.getBoundingClientRect();

    tooltip.textContent = d.name;
    tooltip.classList.add("is-visible");

    // Position tooltip relative to the stage, near the dot
    const x = event.clientX - stageRect.left + 12;
    const y = event.clientY - stageRect.top - 8;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
}

function handleReefLeave() {
    const tooltip = document.getElementById("reef-tooltip");
    tooltip.classList.remove("is-visible");
}

/* ---------- Per-step transitions ---------- */

function mapTransitionTo(stepIdx) {
    if (stepIdx === 0) {
        hideSSTOverlay();
        hideSSTControls();
        showGlobalView();
    }
    if (stepIdx === 1) {
        hideSSTOverlay();
        hideSSTControls();
        zoomToGBR();
    }
    if (stepIdx === 2) {
        hideSSTControls();
        showSSTBaseline();
    }
    if (stepIdx === 3) {
        showSSTBaseline();
        showSSTControls();
        startYearAutoAnimation();
    }
}

/* ---------- Step 0: Global view ---------- */

function showGlobalView() {
    resetProjection();

    // Remove all highlight/dim classes
    mapState.svg.selectAll(".reef-dot")
        .classed("reef-dot--gbr-active", false)
        .classed("reef-dot--pulse", false)
        .classed("is-dimmed", false)
        .style("opacity", null)
        .transition()
        .delay((d, i) => i * 60)
        .duration(700)
        .ease(d3.easeCubicOut)
        .attr("r", d => d.size * 0.6)
        .attr("fill-opacity", 0.85);

    mapState.svg.selectAll(".gbr-brush").interrupt().remove();
}

/* ---------- Step 1: Highlight GBR → brush → zoom ---------- */

function zoomToGBR() {
    mapState.svg.selectAll(".reef-dot")
        .classed("is-dimmed", d => d.name !== "Great Barrier Reef");

    const gbrDot = mapState.svg.selectAll(".reef-dot")
        .filter(d => d.name === "Great Barrier Reef");
    gbrDot
        .classed("reef-dot--gbr-active", true)
        .classed("reef-dot--pulse", true);

    setTimeout(() => drawBrushAroundGBR(), 1300);

    // Zoom to the WIDER view bbox, but the brush stays at the tight GBR bbox
    setTimeout(() => zoomToBBox(GBR_VIEW_BBOX), 2400);

    // After the brush is drawn, the dot has served its purpose.
    setTimeout(() => {
        gbrDot.transition()
            .duration(600)
            .attr("r", 0)
            .style("opacity", 0);
    }, 2200);

    setTimeout(() => {
        mapState.svg.selectAll(".gbr-brush")
            .transition()
            .duration(600)
            .style("opacity", 0)
            .remove();
    }, 6000); 
}

/* ---------- SST data overlay (Step 2) ---------- */

function showSSTBaseline() {
    if (!sstState.metadata) {
        console.warn("Cannot show SST — metadata not loaded");
        return;
    }

    const root = mapState.svg.select(".map-root");
    const sstLayer = mapState.svg.select(".sst-layer");
    const proj = mapState.projection;
    const { lonMin, lonMax, latMin, latMax } = GBR_BBOX;

    // Pixel coords of the brush area's corners
    const topLeft = proj([lonMin, latMax]);
    const bottomRight = proj([lonMax, latMin]);
    const imgX = topLeft[0];
    const imgY = topLeft[1];
    const imgW = bottomRight[0] - topLeft[0];
    const imgH = bottomRight[1] - topLeft[1];

    // 1. Spotlight overlay: a big rect with the brush shape "punched out"
    // We use SVG mask to create the hole.
    let defs = mapState.svg.select("defs");
    if (defs.empty()) defs = mapState.svg.append("defs");

    // Remove old mask if any
    defs.select("#spotlight-mask").remove();

    const mask = defs.append("mask").attr("id", "spotlight-mask");
    // White = visible in the masked element. Black = hidden.
    // We want everything visible EXCEPT the brush rect, so:
    mask.append("rect")
        .attr("width", "100%").attr("height", "100%")
        .attr("fill", "white");
    mask.append("rect")
        .attr("x", imgX).attr("y", imgY)
        .attr("width", imgW).attr("height", imgH)
        .attr("fill", "black");

    // The overlay itself: a viewport-sized rect that uses the mask.
    // Using the SVG's viewBox dimensions to size it.
    const vb = mapState.svg.attr("viewBox").split(/\s+/).map(Number);

    root.selectAll(".spotlight-overlay").remove();
    root.append("rect")
        .attr("class", "spotlight-overlay")
        .attr("x", vb[0]).attr("y", vb[1])
        .attr("width", vb[2]).attr("height", vb[3])
        .attr("mask", "url(#spotlight-mask)");

    // white no-data background
    sstLayer.selectAll(".sst-nodata-bg").remove();
    sstLayer.append("rect")
        .attr("class", "sst-nodata-bg")
        .attr("x", imgX)
        .attr("y", imgY)
        .attr("width", imgW)
        .attr("height", imgH)
        .attr("fill", "white");

    // 2. The SST data image, positioned at the brush bounds
    sstLayer.selectAll(".sst-image").remove();
    sstLayer.append("image")
        .attr("class", "sst-image")
        .attr("href", `docs/modis_data/sst_${sstState.currentYear}.png`)
        .attr("x", imgX).attr("y", imgY)
        .attr("width", imgW).attr("height", imgH)
        .attr("preserveAspectRatio", "none");

    // 3. A transparent hit-area for tooltip detection
    root.selectAll(".sst-hit-area").remove();
    root.append("rect")
        .attr("class", "sst-hit-area")
        .attr("x", imgX).attr("y", imgY)
        .attr("width", imgW).attr("height", imgH)
        .attr("fill", "transparent")
        .style("cursor", "crosshair")
        .on("mousemove", handleSSTHover)
        .on("mouseleave", handleSSTLeave);

    // Fade in the overlay and the image
    setTimeout(() => {
        mapState.svg.selectAll(".spotlight-overlay").classed("is-visible", true);
        mapState.svg.selectAll(".sst-image").classed("is-visible", true);
    }, 50);

    // Create tooltip element if it doesn't exist
    const stage = document.getElementById("map-stage");
    if (!document.getElementById("sst-tooltip")) {
        d3.select(stage).append("div")
            .attr("class", "sst-tooltip")
            .attr("id", "sst-tooltip");
    }

    loadPixelData();
    updateLegend();
}

function hideSSTOverlay() {
    mapState.svg.selectAll(".spotlight-overlay")
        .classed("is-visible", false)
        .transition().delay(600).remove();
    mapState.svg.selectAll(".sst-image")
        .classed("is-visible", false)
        .transition().delay(600).remove();
    mapState.svg.selectAll(".sst-nodata-bg").remove();
    mapState.svg.selectAll(".sst-hit-area").remove();
}

function handleSSTHover(event) {
    const tooltip = document.getElementById("sst-tooltip");
    const stage = document.getElementById("map-stage");
    if (!tooltip || !stage) return;

    const year = sstState.currentYear;
    let html = `<span class="sst-tooltip__year">${year}</span>`;

    // Get the pixel value at the cursor location
    const pixelValue = getPixelValueAtCursor(event);

    if (pixelValue !== null) {
        // Have per-pixel data
        if (sstState.mode === "sst") {
            html += `SST: <span class="sst-tooltip__value">${pixelValue.toFixed(2)}°C</span>`;
        } else {
            const sign = pixelValue >= 0 ? "+" : "";
            html += `Anomaly: <span class="sst-tooltip__value">${sign}${pixelValue.toFixed(2)}°C</span>`;
        }
    } else {
        // Fallback: show the regional mean
        if (sstState.mode === "sst") {
            const stats = sstState.metadata?.yearly_stats?.[year];
            if (stats) {
                html += `Mean SST: <span class="sst-tooltip__value">${stats.mean_sst.toFixed(2)}°C</span>`;
            }
        } else {
            const anom = sstState.metadata?.yearly_anomaly?.[year];
            if (anom) {
                const sign = anom.mean_anomaly >= 0 ? "+" : "";
                html += `Mean anomaly: <span class="sst-tooltip__value">${sign}${anom.mean_anomaly.toFixed(2)}°C</span>`;
            }
        }
    }

    tooltip.innerHTML = html;
    tooltip.classList.add("is-visible");

    const stageRect = stage.getBoundingClientRect();
    tooltip.style.left = `${event.clientX - stageRect.left + 12}px`;
    tooltip.style.top = `${event.clientY - stageRect.top - 12}px`;
}

function handleSSTLeave() {
    const tooltip = document.getElementById("sst-tooltip");
    if (tooltip) tooltip.classList.remove("is-visible");
}

function updateSSTImage() {
    const img = mapState.svg.select(".sst-image");
    if (img.empty()) return;

    const prefix = sstState.mode === "anomaly" ? "anomaly" : "sst";
    const path = `docs/modis_data/${prefix}_${sstState.currentYear}.png`;
    img.attr("href", path);

    const yearDisplay = document.getElementById("sst-year-display");
    if (yearDisplay) yearDisplay.textContent = sstState.currentYear;

    // Load the per-pixel data for tooltip use (async, doesn't block)
    loadPixelData();
}

function initSSTControls() {
    const slider = document.getElementById("sst-year-slider");
    const toggle = document.getElementById("sst-toggle");

    if (!slider || !toggle) {
        console.warn("SST controls not found in DOM");
        return;
    }

    // Slider: when user drags it, update the year and image
    slider.addEventListener("input", (e) => {
        // If the auto-animation is running, cancel it (user took control)
        if (sstState.autoAnimationId !== null) {
            cancelAnimationFrame(sstState.autoAnimationId);
            sstState.autoAnimationId = null;
            sstState.autoAnimationDone = true;
            slider.disabled = false;
        }
        sstState.currentYear = +e.target.value;
        updateSSTImage();
    });

    // Toggle: swap between SST and anomaly modes
    toggle.addEventListener("click", () => {
        if (sstState.mode === "sst") {
            sstState.mode = "anomaly";
            toggle.classList.add("is-anomaly");
            toggle.querySelector(".sst-toggle__label").textContent = "Show as SST";
        } else {
            sstState.mode = "sst";
            toggle.classList.remove("is-anomaly");
            toggle.querySelector(".sst-toggle__label").textContent = "Show as anomaly";
        }
        updateSSTImage();
        updateLegend();
    });

    updateLegend();
}

function startYearAutoAnimation() {
    const slider = document.getElementById("sst-year-slider");
    if (!slider) return;

    // If already done before, just enable slider and skip animation
    if (sstState.autoAnimationDone) {
        slider.disabled = false;
        return;
    }

    slider.disabled = true;
    const startYear = 2003;
    const endYear = 2022;
    const totalDuration = 8000;  // 8 seconds for the full progression
    const startTime = performance.now();

    function step(now) {
        const elapsed = now - startTime;
        const t = Math.min(1, elapsed / totalDuration);

        // Linear progression — could ease but linear feels natural for a timeline
        const year = Math.round(startYear + (endYear - startYear) * t);

        if (year !== sstState.currentYear) {
            sstState.currentYear = year;
            slider.value = year;
            updateSSTImage();
        }

        if (t < 1) {
            sstState.autoAnimationId = requestAnimationFrame(step);
        } else {
            sstState.autoAnimationId = null;
            sstState.autoAnimationDone = true;
            slider.disabled = false;
        }
    }

    sstState.autoAnimationId = requestAnimationFrame(step);
}

function stopYearAutoAnimation() {
    if (sstState.autoAnimationId !== null) {
        cancelAnimationFrame(sstState.autoAnimationId);
        sstState.autoAnimationId = null;
    }
}

function showSSTControls() {
    const controls = document.getElementById("sst-controls");
    if (controls) controls.classList.add("is-visible");
}

function hideSSTControls() {
    const controls = document.getElementById("sst-controls");
    if (controls) controls.classList.remove("is-visible");
    stopYearAutoAnimation();
}

async function loadPixelData() {
    const key = `${sstState.mode}_${sstState.currentYear}`;
    if (sstState.pixelDataKey === key) return;  // already loaded

    const path = `docs/modis_data/${key}.json`;
    try {
        sstState.pixelData = await d3.json(path);
        sstState.pixelDataKey = key;
    } catch (err) {
        console.warn(`Pixel data not found: ${path}`);
        sstState.pixelData = null;
        sstState.pixelDataKey = null;
    }
}

/**
 * Given a mouseevent, compute the temperature value at that pixel
 * by looking up the cursor's geographic coordinates in the loaded
 * per-pixel data array.
 * Returns null if data isn't available or the cursor is over a no-data pixel.
 */
function getPixelValueAtCursor(event) {
    if (!sstState.pixelData) return null;

    const stage = document.getElementById("map-stage");
    const svg = mapState.svg.node();
    if (!stage || !svg) return null;

    // Convert mouse position to SVG coordinates (handles zoom/pan correctly)
    const pt = svg.createSVGPoint();
    pt.x = event.clientX;
    pt.y = event.clientY;
    const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());

    // Use the projection to invert: SVG coords → lon/lat
    const [lon, lat] = mapState.projection.invert([svgPt.x, svgPt.y]);

    // Check if cursor is within the GBR bbox at all
    const { lonMin, lonMax, latMin, latMax } = GBR_BBOX;
    if (lon < lonMin || lon > lonMax || lat < latMin || lat > latMax) return null;

    // Convert geographic position to pixel index in the data array.
    // Remember: lat runs high→low in the array (89° at index 0, -89° at the end).
    const [nLat, nLon] = sstState.pixelData.shape;
    const latFrac = (latMax - lat) / (latMax - latMin);   // 0 at top, 1 at bottom
    const lonFrac = (lon - lonMin) / (lonMax - lonMin);   // 0 at left, 1 at right

    const latIdx = Math.floor(latFrac * nLat);
    const lonIdx = Math.floor(lonFrac * nLon);

    // Bounds check
    if (latIdx < 0 || latIdx >= nLat || lonIdx < 0 || lonIdx >= nLon) return null;

    const flatIdx = latIdx * nLon + lonIdx;
    const value = sstState.pixelData.values[flatIdx];
    return value;  // null if it's a no-data pixel (land, cloud)
}

function updateLegend() {
    const bar = document.getElementById("sst-legend-bar");
    const minLabel = document.getElementById("sst-legend-min");
    const maxLabel = document.getElementById("sst-legend-max");
    if (!bar || !minLabel || !maxLabel) return;

    if (sstState.mode === "sst") {
        bar.classList.remove("is-anomaly");
        bar.classList.add("is-sst");
        minLabel.textContent = "22°C";
        maxLabel.textContent = "32°C";
    } else {
        bar.classList.remove("is-sst");
        bar.classList.add("is-anomaly");
        minLabel.textContent = "−2.5°C";
        maxLabel.textContent = "+2.5°C";
    }
}

/* ---------- Brush: rectangle that expands from a corner ---------- */

function drawBrushAroundGBR() {
    const root = mapState.svg.select(".map-root");

    // Get pixel coords of the bbox corners under the CURRENT projection
    const proj = mapState.projection;
    const topLeft = proj([GBR_BBOX.lonMin, GBR_BBOX.latMax]);
    const bottomRight = proj([GBR_BBOX.lonMax, GBR_BBOX.latMin]);

    const startX = topLeft[0];
    const startY = topLeft[1];
    const fullW = bottomRight[0] - topLeft[0];
    const fullH = bottomRight[1] - topLeft[1];

    // Create the rect, anchored at the top-left corner
    const rect = root.append("rect")
        .attr("class", "gbr-brush")
        .attr("x", startX)
        .attr("y", startY)
        .attr("width", 0)
        .attr("height", 0);

    // Animate: first expand width (drawing rightward), then height (drawing downward)
    rect.transition()
        .duration(450)
        .ease(d3.easeQuadOut)
        .attr("width", fullW)
        .transition()
        .duration(450)
        .ease(d3.easeQuadOut)
        .attr("height", fullH);
}

/* ---------- Zoom: center + scale interpolation ---------- */

function zoomToBBox(bbox) {
    const { width, height, projection } = mapState;

    const targetCenter = [
        (bbox.lonMin + bbox.lonMax) / 2,
        (bbox.latMin + bbox.latMax) / 2,
    ];

    const bboxDegLon = bbox.lonMax - bbox.lonMin;
    const bboxDegLat = bbox.latMax - bbox.latMin;

    const fillFactor = 1.0;
    const targetScaleByWidth = (width * fillFactor * 57) / bboxDegLon;
    const targetScaleByHeight = (height * fillFactor * 57) / bboxDegLat;
    const targetScale = Math.min(targetScaleByWidth, targetScaleByHeight);

    const startCenter = projection.center();
    const startScale = projection.scale();

    if (Math.abs(targetScale - startScale) / startScale < 0.05 &&
        Math.abs(targetCenter[0] - startCenter[0]) < 1) {
        return;
    }

    d3.transition()
        .duration(3500)
        .ease(d3.easeCubicInOut)
        .tween("zoom", () => {
            return (t) => {
                const centerT = Math.min(1, t / 0.6);
                const easedCenterT = d3.easeCubicInOut(centerT);
                const scaleT = Math.max(0, Math.min(1, (t - 0.3) / 0.7));
                const easedScaleT = d3.easeCubicInOut(scaleT);

                const lon = startCenter[0] + (targetCenter[0] - startCenter[0]) * easedCenterT;
                const lat = startCenter[1] + (targetCenter[1] - startCenter[1]) * easedCenterT;
                const k = startScale + (targetScale - startScale) * easedScaleT;

                projection.center([lon, lat]).scale(k);
                redrawAll();
            };
        });
}

/* ---------- Helpers ---------- */

function resetProjection() {
    const { width, height } = mapState;

    const startCenter = mapState.projection.center();
    const startScale = mapState.projection.scale();

    const endCenter = [0, 0];
    const endScale = width / 5.8;

    const interp = d3.interpolateObject(
        { lon: startCenter[0], lat: startCenter[1], k: startScale },
        { lon: endCenter[0], lat: endCenter[1], k: endScale }
    );

    d3.transition()
        .duration(1400)
        .ease(d3.easeCubicInOut)
        .tween("zoom-reset", () => (t) => {
            const v = interp(t);
            mapState.projection
                .center([v.lon, v.lat])
                .scale(v.k);
            redrawAll();
        });

    mapState.svg.selectAll(".gbr-brush").remove();
}

function redrawAll() {
    mapState.svg.select(".map-graticule").attr("d", mapState.path);
    if (mapState.worldLoaded) {
        mapState.svg.select(".map-land").attr("d", mapState.path);
    }
    mapState.svg.selectAll(".reef-dot")
        .attr("cx", d => mapState.projection([d.lon, d.lat])[0])
        .attr("cy", d => mapState.projection([d.lon, d.lat])[1]);

    // Re-anchor brush rect to its geographic position every frame
    const brush = mapState.svg.select(".gbr-brush");
    if (!brush.empty()) {
        const proj = mapState.projection;
        const tl = proj([GBR_BBOX.lonMin, GBR_BBOX.latMax]);
        const br = proj([GBR_BBOX.lonMax, GBR_BBOX.latMin]);
        // Only update if the brush has finished its initial draw
        // (the initial animation manages its own x/y/width/height)
        if (+brush.attr("width") > 0 && +brush.attr("height") > 0) {
            brush
                .attr("x", tl[0])
                .attr("y", tl[1])
                .attr("width", br[0] - tl[0])
                .attr("height", br[1] - tl[1]);
        }
    }
}


/* ============================================ */
/*  ENTRY POINT                                  */
/* ============================================ */

document.addEventListener("DOMContentLoaded", () => {
    console.log("Coral story loaded.");
    loadSSTMetadata().then(() => {
        initMap();
        initScrollytelling();
        initSSTControls();
    });
});
