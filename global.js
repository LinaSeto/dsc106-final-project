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
    // ===== Section 2 (map / SST / anomaly) =====
    const baselineScroller = scrollama();
    baselineScroller
        .setup({
            step: "#baseline .step",
            offset: 0.5,
        })
        .onStepEnter((response) => {
            console.log("Section 2 step entered:", response.element.dataset.step);
            response.element.classList.add("is-active");
            const stepIdx = +response.element.dataset.step;
            mapTransitionTo(stepIdx);
        })
        .onStepExit((response) => {
            response.element.classList.remove("is-active");
        });

    // ===== Section 3 (bleaching chart) =====
    const bleachScroller = scrollama();
    bleachScroller
        .setup({
            step: "#bleaching .step",
            offset: 0.5,
        })
        .onStepEnter((response) => {
            console.log("Section 3 step entered:", response.element.dataset.step);
            response.element.classList.add("is-active");
            const stepIdx = +response.element.dataset.step;
            // We'll write bleachTransitionTo in the next round
            if (typeof bleachTransitionTo === "function") {
                bleachTransitionTo(stepIdx);
            }
            // CRITICAL: hide Section 2's overlays so they don't bleed into Section 3
            hideSSTOverlay();
            hideSSTControls();
            const step2Legend = document.getElementById("sst-legend-step2");
            if (step2Legend) step2Legend.classList.remove("is-visible");
        })
        .onStepExit((response) => {
            response.element.classList.remove("is-active");
        });

    window.addEventListener("resize", () => {
        baselineScroller.resize();
        bleachScroller.resize();
    });
}

/* ============================================ */
/*  SECTION 3 · BLEACHING CHART                  */
/* ============================================ */

let bleachState = {
    data: null, 
    svg: null,
    width: 0,
    height: 0,
    margin: { top: 40, right: 40, bottom: 50, left: 70 },
    xScale: null,
    yScale: null,
    initialized: false,
    activeYears: { "2016": true, "2022": true },
};

async function loadBleachData() {
    try {
        bleachState.data = await d3.json("docs/modis_data/bleaching_8day.json");
        console.log("Bleach data loaded:", bleachState.data);
    } catch (err) {
        console.error("Failed to load bleach data:", err);
    }
}

function initBleachChart() {
    if (!bleachState.data) {
        console.warn("Bleach data not loaded yet");
        return;
    }
    if (bleachState.initialized) return;

    const stage = document.getElementById("bleach-stage");
    if (!stage) return;

    const rect = stage.getBoundingClientRect();
    bleachState.width = rect.width;
    bleachState.height = rect.height;

    const { width, height, margin } = bleachState;
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    // Create SVG
    bleachState.svg = d3.select(stage).append("svg")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("preserveAspectRatio", "xMidYMid meet");

    const root = bleachState.svg.append("g")
        .attr("class", "chart-root")
        .attr("transform", `translate(${margin.left},${margin.top})`);

    // Convert dates: all years projected onto a single calendar year for overlay
    const parseDate = d3.timeParse("%Y-%m-%d");
    const allData = [...bleachState.data.events["2016"], ...bleachState.data.events["2022"]];
    allData.forEach(d => {
        const parsed = parseDate(d.date);
        // Project onto year 2000 (a common reference year) so both years share an x-axis
        d.dateObj = new Date(2000, parsed.getMonth(), parsed.getDate());
        d.tempC = d.sst;
    });

    // Scales
    bleachState.xScale = d3.scaleTime()
        .domain([new Date(2000, 0, 1), new Date(2000, 11, 31)])
        .range([0, innerW]);

    bleachState.yScale = d3.scaleLinear()
        .domain([22, 32])
        .range([innerH, 0]);

    // === Layers (back to front) ===

    // 1. Danger zone shading (above threshold)
    const threshold = bleachState.data.bleaching_threshold_c;
    root.append("rect")
        .attr("class", "bleach-danger-zone")
        .attr("x", 0)
        .attr("y", 0)
        .attr("width", innerW)
        .attr("height", bleachState.yScale(threshold));

    // 2. Axes
    const xAxis = d3.axisBottom(bleachState.xScale)
        .ticks(d3.timeMonth.every(1))
        .tickFormat(d3.timeFormat("%b"))
        .tickSizeOuter(0);

    const yAxis = d3.axisLeft(bleachState.yScale)
        .ticks(5)
        .tickFormat(d => `${d}°`)
        .tickSizeOuter(0);

    root.append("g")
        .attr("class", "bleach-axis")
        .attr("transform", `translate(0,${innerH})`)
        .call(xAxis);

    root.append("g")
        .attr("class", "bleach-axis")
        .call(yAxis);

    root.append("text")
        .attr("class", "bleach-axis-label")
        .attr("text-anchor", "middle")
        .attr("transform", `translate(-35,${innerH / 2}) rotate(-90)`)
        .text("Sea surface temperature");

    // 3. Threshold line + label
    root.append("line")
        .attr("class", "bleach-threshold-line")
        .attr("x1", 0).attr("x2", innerW)
        .attr("y1", bleachState.yScale(threshold))
        .attr("y2", bleachState.yScale(threshold));

    root.append("text")
        .attr("class", "bleach-threshold-label")
        .attr("x", innerW / 2)
        .attr("y", bleachState.yScale(threshold) - 8)
        .attr("text-anchor", "middle")
        .text(`Bleaching threshold · ${threshold}°C`);

    // 4. Lines and points (per year)
    const lineGen = d3.line()
        .x(d => bleachState.xScale(d.dateObj))
        .y(d => bleachState.yScale(d.tempC))
        .curve(d3.curveMonotoneX);

    ["2016", "2022"].forEach(year => {
        const yearData = bleachState.data.events[year]
            .filter(d => d.sst !== null)
            .map(d => ({
                ...d,
                dateObj: new Date(2000,
                    parseDate(d.date).getMonth(),
                    parseDate(d.date).getDate()),
                tempC: d.sst,
            }));

        // Line
        root.append("path")
            .datum(yearData)
            .attr("class", `bleach-line bleach-line--${year}`)
            .attr("d", lineGen);

        // Points
        root.append("g")
            .attr("class", `bleach-points bleach-points--${year}`)
            .selectAll("circle")
            .data(yearData)
            .enter()
            .append("circle")
            .attr("class", `bleach-point bleach-point--${year}`)
            .attr("cx", d => bleachState.xScale(d.dateObj))
            .attr("cy", d => bleachState.yScale(d.tempC))
            .attr("r", 0)
            .on("mousemove", handleBleachHover)
            .on("mouseleave", handleBleachLeave);
    });

    // 5. DHW annotation (Step 2 reveal)
    const annoG = root.append("g").attr("class", "bleach-annotation");

    // Position: pointing at the late-Feb 2016 peak
    const annoX = bleachState.xScale(new Date(2000, 1, 21.5));
    const annoY = bleachState.yScale(30.6);

    // The vertical line pointing down from text to peak — raise the start
    annoG.append("line")
        .attr("x1", annoX)
        .attr("y1", annoY - 40) 
        .attr("x2", annoX)
        .attr("y2", annoY - 5);

    // Primary text — starts AT the line (text-anchor: start), positioned to the right
    annoG.append("text")
        .attr("x", annoX - 15) 
        .attr("y", annoY - 60) 
        .attr("text-anchor", "start") // text begins at this x position
        .style("font-weight", "510") 
        .text("Peak: 30.6°C");

    // Secondary text — same anchoring, below the primary
    annoG.append("text")
        .attr("x", annoX - 15)
        .attr("y", annoY - 45)
        .attr("text-anchor", "start")
        .style("font-size", "11px")
        .style("font-family", "var(--f-body)")
        .style("font-style", "normal")
        .style("fill", "var(--c-ink-mute)")
        .text("five consecutive 8-day windows above threshold");

    // 5b. 2022 annotation (Step 3 reveal)
    const anno2022G = root.append("g").attr("class", "bleach-annotation-2022");

    // Position: pointing at the early Jan 2022 peak
    const anno2022X = bleachState.xScale(new Date(2000, 0, 4.8)); // early Jan
    const anno2022Y = bleachState.yScale(30.6); // 2022's early-Jan peak

    anno2022G.append("text")
        .attr("x", anno2022X + 6)
        .attr("y", anno2022Y - 60)
        .attr("text-anchor", "start")
        .style("font-weight", "510") 
        .text("And again in 2022");

    anno2022G.append("text")
        .attr("x", anno2022X + 6)
        .attr("y", anno2022Y - 45)
        .attr("text-anchor", "start")
        .style("font-size", "11px")
        .style("font-family", "var(--f-body)")
        .style("font-style", "normal")
        .style("fill", "var(--c-ink-mute)")
        .text("seven 8-day windows above threshold!");

    // 6. Tooltip element
    if (!document.getElementById("bleach-tooltip")) {
        d3.select(stage).append("div")
            .attr("class", "bleach-tooltip")
            .attr("id", "bleach-tooltip");
    }

    bleachState.initialized = true;
}

function bleachTransitionTo(stepIdx) {
    if (!bleachState.initialized) initBleachChart();
    if (!bleachState.svg) return;

    const svg = bleachState.svg;

    // STEP 0: only 2016, no threshold yet
    if (stepIdx === 0) {
        showYear("2016", true);
        showYear("2022", false);
        svg.selectAll(".bleach-threshold-line").classed("is-visible", false);
        svg.selectAll(".bleach-threshold-label").classed("is-visible", false);
        svg.selectAll(".bleach-danger-zone").classed("is-visible", false);
        svg.selectAll(".bleach-annotation").classed("is-visible", false);
        svg.selectAll(".bleach-annotation-2022").classed("is-visible", false);
        resetPointHighlight();
    }

    // STEP 1: threshold appears, points above it recolor
    if (stepIdx === 1) {
        showYear("2016", true);
        showYear("2022", false);
        svg.selectAll(".bleach-threshold-line").classed("is-visible", true);
        svg.selectAll(".bleach-threshold-label").classed("is-visible", true);
        svg.selectAll(".bleach-danger-zone").classed("is-visible", false);
        svg.selectAll(".bleach-annotation").classed("is-visible", false);
        svg.selectAll(".bleach-annotation-2022").classed("is-visible", false);
        highlightAboveThreshold();
    }

    // STEP 2: danger zone + annotation
    if (stepIdx === 2) {
        showYear("2016", true);
        showYear("2022", false);
        svg.selectAll(".bleach-threshold-line").classed("is-visible", true);
        svg.selectAll(".bleach-threshold-label").classed("is-visible", true);
        svg.selectAll(".bleach-danger-zone").classed("is-visible", true);
        svg.selectAll(".bleach-annotation").classed("is-visible", true);
        svg.selectAll(".bleach-annotation-2022").classed("is-visible", false);
    }

    // STEP 3: 2022 fades in alongside 2016
    if (stepIdx === 3) {
        showYear("2016", true);
        showYear("2022", true);
        svg.selectAll(".bleach-threshold-line").classed("is-visible", true);
        svg.selectAll(".bleach-threshold-label").classed("is-visible", true);
        svg.selectAll(".bleach-danger-zone").classed("is-visible", true);
        svg.selectAll(".bleach-annotation").classed("is-visible", false); // hide 2016-specific annotation
        svg.selectAll(".bleach-annotation-2022").classed("is-visible", true);
        highlightAboveThreshold();
    }

    // STEP 4: both years, toggle becomes active
    if (stepIdx === 4) {
        // Use the toggle state instead of forcing both on
        showYear("2016", bleachState.activeYears["2016"]);
        showYear("2022", bleachState.activeYears["2022"]);
        svg.selectAll(".bleach-threshold-line").classed("is-visible", true);
        svg.selectAll(".bleach-threshold-label").classed("is-visible", true);
        svg.selectAll(".bleach-danger-zone").classed("is-visible", true);
        svg.selectAll(".bleach-annotation").classed("is-visible", false);
        svg.selectAll(".bleach-annotation-2022").classed("is-visible", false);
    }
}


function showYear(year, visible) {
    const svg = bleachState.svg;

    // Lines: use visibility (instant) — no fade transition
    svg.selectAll(`.bleach-line--${year}`)
        .classed("is-visible", visible)
        // .style("opacity", null)
        .style("visibility", visible ? "visible" : "hidden");

    // Points group: also use visibility (instant)
    svg.selectAll(`.bleach-points--${year}`)
        .style("visibility", visible ? "visible" : "hidden");

    // Points radius: transition normally
    svg.selectAll(`.bleach-points--${year} circle`)
        .transition()
        .duration(600)
        .attr("r", visible ? 4 : 0);
}

function highlightAboveThreshold() {
    const threshold = bleachState.data.bleaching_threshold_c;
    bleachState.svg.selectAll(".bleach-point")
        .transition()
        .duration(500)
        .attr("r", 4)
        .style("opacity", d => d.tempC >= threshold ? 1 : 0.45);

    // Fade the line stroke (the whole line, since it's a single path)
    bleachState.svg.selectAll(".bleach-line")
        .transition()
        .duration(500)
        .style("opacity", 0.5);
}

function resetPointHighlight() {
    bleachState.svg.selectAll(".bleach-point")
        .transition()
        .duration(500)
        .attr("r", 4)
        .style("opacity", 1);
    bleachState.svg.selectAll(".bleach-line")
        .transition()
        .duration(500)
        .style("opacity", 1);
}

function initBleachToggle() {
    const buttons = document.querySelectorAll("#bleach-toggle .bleach-toggle__btn");
    buttons.forEach(btn => {
        btn.addEventListener("click", () => {
            const year = btn.dataset.year;
            btn.classList.toggle("is-active");
            bleachState.activeYears[year] = btn.classList.contains("is-active");
            showYear(year, bleachState.activeYears[year]);
        });
    });
}

function handleBleachHover(event, d) {
    const tooltip = document.getElementById("bleach-tooltip");
    const stage = document.getElementById("bleach-stage");
    if (!tooltip || !stage) return;

    const originalDate = new Date(d.date);
    const dateStr = d3.timeFormat("%b %d, %Y")(originalDate);

    tooltip.innerHTML = `
        <span class="bleach-tooltip__date">${dateStr}</span>
        <span class="bleach-tooltip__temp">${d.tempC.toFixed(2)}°C</span>
    `;
    tooltip.classList.add("is-visible");

    const stageRect = stage.getBoundingClientRect();
    tooltip.style.left = `${event.clientX - stageRect.left + 12}px`;
    tooltip.style.top = `${event.clientY - stageRect.top - 12}px`;
}

function handleBleachLeave() {
    const tooltip = document.getElementById("bleach-tooltip");
    if (tooltip) tooltip.classList.remove("is-visible");
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
    const step2Legend = document.getElementById("sst-legend-step2");

    if (stepIdx === 0) {
        hideSSTOverlay();
        hideSSTControls();
        if (step2Legend) step2Legend.classList.remove("is-visible");
        showGlobalView();
    }
    if (stepIdx === 1) {
        hideSSTOverlay();
        hideSSTControls();
        if (step2Legend) step2Legend.classList.remove("is-visible");
        zoomToGBR();
    }
    if (stepIdx === 2) {
        hideSSTControls();
        if (step2Legend) step2Legend.classList.add("is-visible");
        showSSTBaseline();
    }
    if (stepIdx === 3) {
        if (step2Legend) step2Legend.classList.remove("is-visible");
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
/*  SECTION · CASCADING EFFECTS                  */
/*  Click-to-flip cards                          */
/* ============================================ */

function initEffectCards() {
    const cards = document.querySelectorAll(".card");
    if (cards.length === 0) return;

    cards.forEach((card) => {
        card.addEventListener("click", () => {
            card.classList.toggle("is-flipped");
        });

        // Keyboard accessibility — Enter or Space to flip
        card.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                card.classList.toggle("is-flipped");
            }
        });
    });
}

/* ============================================ */
/*  ENTRY POINT                                  */
/* ============================================ */

document.addEventListener("DOMContentLoaded", () => {
    console.log("Coral story loaded.");
    Promise.all([
        loadSSTMetadata(),
        loadBleachData(),
    ]).then(() => {
        initMap();
        initScrollytelling();
        initSSTControls();
        initEffectCards();
        initBleachToggle();
    });
});
