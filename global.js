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
    unit: "C",
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

function convertTemp(celsius, isAnomaly) {
    if (sstState.unit === "F") {
        return isAnomaly ? celsius * 9 / 5 : celsius * 9 / 5 + 32; // anomaly = difference, no offset
    }
    return celsius;
}
function unitSymbol() {
    return sstState.unit === "F" ? "°F" : "°C";
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

    // ===== Section · micro temperature variations =====
    const microvarScroller = scrollama();
    microvarScroller
        .setup({
            step: "#microvar .step",
            offset: 0.5,
        })
        .onStepEnter((response) => {
            response.element.classList.add("is-active");
            const stepIdx = +response.element.dataset.step;
            microvarTransitionTo(stepIdx);
        })
        .onStepExit((response) => {
            response.element.classList.remove("is-active");
        });

    // ===== Section · deep mesophotic reefs =====
    const mesoScroller = scrollama();
    mesoScroller
        .setup({ step: "#mesophotic .step", offset: 0.5 })
        .onStepEnter((response) => {
            response.element.classList.add("is-active");
            mesoTransitionTo(+response.element.dataset.step);
        })
        .onStepExit((response) => {
            response.element.classList.remove("is-active");
        });

    // ===== Section · water stress cards =====
    const stressScroller = scrollama();
    stressScroller
        .setup({ step: "#stress .step", offset: 0.5 })
        .onStepEnter((response) => {
            response.element.classList.add("is-active");
            StressModule.transitionTo(+response.element.dataset.step);
        })
        .onStepExit((response) => {
            response.element.classList.remove("is-active");
        });

    window.addEventListener("resize", () => {
        baselineScroller.resize();
        bleachScroller.resize();
        microvarScroller.resize();
        mesoScroller.resize();
        stressScroller.resize();
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
        .style("font-size", "13px")
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
        .style("font-size", "13px")
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

    // Caption — what each point represents
    root.append("text")
        .attr("class", "bleach-caption")
        .attr("x", 7)
        .attr("y", innerH - 27)
        .attr("text-anchor", "start")
        .call(t => {
            t.append("tspan")
                .attr("x", 7)
                .attr("dy", "0em")
                .text("*Each point is the 8-day average");
            t.append("tspan")
                .attr("x", 7)
                .attr("dy", "1.2em")
                .text("sea surface temperature");
        });
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
/*  SECTION · MICRO TEMPERATURE VARIATIONS       */
/* ============================================ */
let microvarState = {
    data: null,
    series: null,
    svg: null,
    root: null,
    width: 0,
    height: 0,
    margin: { top: 32, right: 40, bottom: 68, left: 84 },
    xScale: null,
    yScale: null,
    xAxisG: null,
    innerW: 0,
    innerH: 0,
    windowStart: 0,
    windowDays: 14,
    view: "bands",
    initialized: false,
};

async function loadMicroVarData() {
    try {
        microvarState.data = await d3.json("docs/modis_data/microvar_2020.json");
        const parse = d3.timeParse("%Y-%m-%d %H:%M:%S");
        const { date, sst } = microvarState.data.data;
        microvarState.series = date.map((d, i) => ({
            date: parse(d),
            sst: sst[i],
            idx: i,
        }));
        console.log("Micro-variation data loaded:", microvarState.series.length, "days");
    } catch (err) {
        console.error("Failed to load micro-variation data:", err);
    }
}

function initMicroVarChart() {
    if (!microvarState.data) { console.warn("Micro-variation data not loaded yet"); return; }
    if (microvarState.initialized) return;
    const stage = document.getElementById("microvar-stage");
    if (!stage) return;

    const rect = stage.getBoundingClientRect();
    microvarState.width = rect.width;
    microvarState.height = rect.height;
    const { width, height, margin } = microvarState;
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    microvarState.innerW = innerW;
    microvarState.innerH = innerH;

    const { summer_mean, summer_std, std_limits } = microvarState.data;

    microvarState.svg = d3.select(stage).append("svg")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("preserveAspectRatio", "xMidYMid meet");

    const root = microvarState.svg.append("g")
        .attr("class", "microvar-root")
        .attr("transform", `translate(${margin.left},${margin.top})`);
    microvarState.root = root;

    const ext = d3.extent(microvarState.series, d => d.sst);
    const yPad = 0.3;
    const y = d3.scaleLinear()
        .domain([ext[0] - yPad, ext[1] + yPad])
        .range([innerH, 0]);
    microvarState.yScale = y;
    microvarState.xScale = d3.scaleTime().range([0, innerW]);

    const threshHi = summer_mean + std_limits;
    const threshLo = summer_mean - std_limits;
    const trueHi = summer_mean + summer_std;
    const trueLo = summer_mean - summer_std;

    // 1. Shaded danger zones — everything beyond the safe band, top and bottom
    root.append("rect").attr("class", "mv-excess mv-excess--top")
        .attr("x", 0).attr("width", innerW)
        .attr("y", 0).attr("height", y(threshHi));
    root.append("rect").attr("class", "mv-excess mv-excess--bottom")
        .attr("x", 0).attr("width", innerW)
        .attr("y", y(threshLo)).attr("height", innerH - y(threshLo));

    // 2. True-spread band lines
    root.append("line").attr("class", "mv-true mv-true--hi")
        .attr("x1", 0).attr("x2", innerW).attr("y1", y(trueHi)).attr("y2", y(trueHi));
    root.append("line").attr("class", "mv-true mv-true--lo")
        .attr("x1", 0).attr("x2", innerW).attr("y1", y(trueLo)).attr("y2", y(trueLo));

    // 3. Safe (threshold) band lines — amber
    root.append("line").attr("class", "mv-thresh mv-thresh--hi")
        .attr("x1", 0).attr("x2", innerW).attr("y1", y(threshHi)).attr("y2", y(threshHi));
    root.append("line").attr("class", "mv-thresh mv-thresh--lo")
        .attr("x1", 0).attr("x2", innerW).attr("y1", y(threshLo)).attr("y2", y(threshLo));

    // 4. Mean line
    root.append("line").attr("class", "mv-mean")
        .attr("x1", 0).attr("x2", innerW).attr("y1", y(summer_mean)).attr("y2", y(summer_mean));

    // Band labels
    root.append("text").attr("class", "mv-thresh-label")
        .attr("x", innerW).attr("y", y(threshHi) - 5).attr("text-anchor", "end")
        .text(`safe variation (±${std_limits.toFixed(2)}°C)`);
    root.append("text").attr("class", "mv-true-label")
        .attr("x", innerW).attr("y", y(trueHi) - 5).attr("text-anchor", "end")
        .text(`2020 variation (±${summer_std.toFixed(2)}°C)`);

    // 5. Raw daily line + points (populated per window)
    root.append("path").attr("class", "mv-raw-line");
    root.append("g").attr("class", "mv-raw-points");

    // 6. Axes
    microvarState.xAxisG = root.append("g")
        .attr("class", "mv-axis mv-axis--x")
        .attr("transform", `translate(0,${innerH})`);
    root.append("g").attr("class", "mv-axis mv-axis--y")
        .call(d3.axisLeft(y).ticks(5).tickFormat(d => `${d}°`).tickSizeOuter(0));

    // Axis labels
    root.append("text").attr("class", "mv-axis-label")
        .attr("text-anchor", "middle")
        .attr("transform", `translate(${-margin.left + 26},${innerH / 2}) rotate(-90)`)
        .text("Sea surface temperature (°C)");

    root.append("text").attr("class", "mv-axis-label")
        .attr("text-anchor", "middle")
        .attr("x", innerW / 2)
        .attr("y", innerH + margin.bottom - 18)
        .text("2020 bleaching season");

    microvarState.initialized = true;

    if (!document.getElementById("mv-tooltip")) {
        d3.select(stage).append("div").attr("class", "mv-tooltip").attr("id", "mv-tooltip");
    }

    updateWindow(0, false);
}

function updateWindow(start, animate) {
    const { series, windowDays, root } = microvarState;
    const maxStart = series.length - windowDays;
    microvarState.windowStart = Math.max(0, Math.min(maxStart, start));
    const slice = series.slice(microvarState.windowStart, microvarState.windowStart + windowDays);

    const x = microvarState.xScale, y = microvarState.yScale;
    x.domain([slice[0].date, slice[slice.length - 1].date]);

    const xAxis = d3.axisBottom(x).ticks(d3.timeWeek.every(1))
        .tickFormat(d3.timeFormat("%b %d")).tickSizeOuter(0);
    (animate ? microvarState.xAxisG.transition().duration(400) : microvarState.xAxisG).call(xAxis);

    const lineGen = d3.line().x(d => x(d.date)).y(d => y(d.sst)).curve(d3.curveMonotoneX);
    const lineSel = root.select(".mv-raw-line").datum(slice);
    (animate ? lineSel.transition().duration(400) : lineSel).attr("d", lineGen);

    const pts = root.select(".mv-raw-points").selectAll("circle").data(slice, d => d.idx);
    pts.exit().remove();
    pts.enter().append("circle").attr("class", "mv-raw-point").attr("r", 3.5)
        .on("mousemove", handleMicroVarHover)
        .on("mouseleave", handleMicroVarLeave)
        .merge(pts)
        .attr("cx", d => x(d.date)).attr("cy", d => y(d.sst));
}

function handleMicroVarHover(event, d) {
    const tooltip = document.getElementById("mv-tooltip");
    const stage = document.getElementById("microvar-stage");
    if (!tooltip || !stage) return;
    tooltip.innerHTML = `
        <span class="mv-tooltip__date">${d3.timeFormat("%b %d, %Y")(d.date)}</span>
        <span class="mv-tooltip__temp">${d.sst.toFixed(2)}°C</span>
    `;
    tooltip.classList.add("is-visible");
    const stageRect = stage.getBoundingClientRect();
    tooltip.style.left = `${event.clientX - stageRect.left + 12}px`;
    tooltip.style.top = `${event.clientY - stageRect.top - 12}px`;
}
function handleMicroVarLeave() {
    const tooltip = document.getElementById("mv-tooltip");
    if (tooltip) tooltip.classList.remove("is-visible");
}

function windowStd(slice) {
    const mean = d3.mean(slice, d => d.sst);
    return Math.sqrt(d3.mean(slice, d => (d.sst - mean) ** 2));
}

function currentSlice() {
    return microvarState.series.slice(
        microvarState.windowStart,
        microvarState.windowStart + microvarState.windowDays
    );
}

// Per-fortnight band (explore view) — width = this window's spread
function updateMicroVarBands(animate) {
    const { root, yScale: y, data } = microvarState;
    const sd = windowStd(currentSlice());
    const hi = data.summer_mean + sd, lo = data.summer_mean - sd;
    const move = (sel, val) => {
        const s = root.select(sel);
        (animate ? s.transition().duration(300) : s).attr("y1", y(val)).attr("y2", y(val));
    };
    move(".mv-true--hi", hi);
    move(".mv-true--lo", lo);
    const lbl = root.select(".mv-true-label");
    (animate ? lbl.transition().duration(300) : lbl).attr("y", y(hi) - 5);
    lbl.text(`this 2-week window (±${sd.toFixed(2)}°C)`);
}

// Season-wide band (narrative steps) — width = whole-season spread
function setSeasonBands(animate) {
    const { root, yScale: y, data } = microvarState;
    const hi = data.summer_mean + data.summer_std, lo = data.summer_mean - data.summer_std;
    const move = (sel, val) => {
        const s = root.select(sel);
        (animate ? s.transition().duration(300) : s).attr("y1", y(val)).attr("y2", y(val));
    };
    move(".mv-true--hi", hi);
    move(".mv-true--lo", lo);
    const lbl = root.select(".mv-true-label");
    (animate ? lbl.transition().duration(300) : lbl).attr("y", y(hi) - 5);
    lbl.text(`2020 variation (±${data.summer_std.toFixed(2)}°C)`);
}

function setMicroVarView(view) {
    microvarState.view = view;
    const svg = microvarState.svg;
    if (!svg) return;
    const set = (sel, vis) => svg.selectAll(sel).classed("is-visible", vis);
    const raw = svg.selectAll(".mv-raw-line, .mv-raw-points");
    if (view === "raw") {
        raw.transition().duration(400).style("opacity", 1);
        svg.selectAll(".mv-raw-points").style("pointer-events", "all");
        set(".mv-mean", false);
        set(".mv-thresh, .mv-thresh-label", false);
        set(".mv-true, .mv-true-label", false);
        set(".mv-excess", false);
    } else {
        raw.transition().duration(400).style("opacity", 0);
        svg.selectAll(".mv-raw-points").style("pointer-events", "none");
        set(".mv-mean", true);
        set(".mv-thresh, .mv-thresh-label", true);
        set(".mv-true, .mv-true-label", true);
        set(".mv-excess", true);
        updateMicroVarBands(true);
    }
}

function updateMicroVarWindowLabel() {
    const lbl = document.getElementById("microvar-window-label");
    if (!lbl) return;
    const slice = currentSlice();
    const fmt = d3.timeFormat("%b %d");
    lbl.textContent = `${fmt(slice[0].date)} – ${fmt(slice[slice.length - 1].date)}, 2020`;
}

function initMicroVarControls() {
    const slider = document.getElementById("microvar-slider");
    if (slider && microvarState.series) {
        slider.max = microvarState.series.length - microvarState.windowDays;
        slider.value = 0;
        slider.addEventListener("input", (e) => {
            updateWindow(+e.target.value, false);
            if (microvarState.view === "bands") updateMicroVarBands(false);
            updateMicroVarWindowLabel();
        });
    }
    document.querySelectorAll("#microvar-controls .microvar-toggle__btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll("#microvar-controls .microvar-toggle__btn")
                .forEach(b => b.classList.remove("is-active"));
            btn.classList.add("is-active");
            setMicroVarView(btn.dataset.view);
        });
    });
}

function microvarTransitionTo(stepIdx) {
    if (!microvarState.initialized) initMicroVarChart();
    if (!microvarState.svg) return;
    const svg = microvarState.svg;
    const set = (sel, vis) => svg.selectAll(sel).classed("is-visible", vis);
    const showRaw = (on) => {
        svg.selectAll(".mv-raw-line, .mv-raw-points")
            .transition().duration(600).style("opacity", on ? 1 : 0);
        svg.selectAll(".mv-raw-points").style("pointer-events", on ? "all" : "none");
    };

    // STEP 0: raw daily data only
    if (stepIdx === 0) {
        updateWindow(0, false);
        set(".mv-mean", false);
        set(".mv-thresh, .mv-thresh-label", false);
        set(".mv-true, .mv-true-label", false);
        set(".mv-excess", false);
        showRaw(true);
        hideMicroVarSlider();
    }

    // STEP 1: mean + safe band + full danger shading (no coral yet)
    if (stepIdx === 1) {
        set(".mv-mean", true);
        set(".mv-thresh, .mv-thresh-label", true);
        set(".mv-true, .mv-true-label", false);
        set(".mv-excess", true);
        showRaw(false);
        hideMicroVarSlider();
    }

    // STEP 2: coral 2020 lines appear at season-wide spread
    if (stepIdx === 2) {
        setSeasonBands(false);
        set(".mv-mean", true);
        set(".mv-thresh, .mv-thresh-label", true);
        set(".mv-true, .mv-true-label", true);
        set(".mv-excess", true);
        showRaw(false);
        hideMicroVarSlider();
    }

    // STEP 3: explore — controls appear, per-fortnight band, toggle live
    if (stepIdx === 3) {
        microvarState.windowStart = 0;
        const slider = document.getElementById("microvar-slider");
        if (slider) slider.value = 0;
        updateWindow(0, false);
        showMicroVarSlider();
        setMicroVarView(microvarState.view);
        updateMicroVarWindowLabel();
    }
}

// Slider control stubs — harmless until #microvar-controls exists (next chunk)
function showMicroVarSlider() {
    const c = document.getElementById("microvar-controls");
    if (c) c.classList.add("is-visible");
}
function hideMicroVarSlider() {
    const c = document.getElementById("microvar-controls");
    if (c) c.classList.remove("is-visible");
}

/* ============================================ */
/*  SECTION · DEEP MESOPHOTIC REEFS               */
/* ============================================ */
let mesoState = {
    data: null,
    series: null,
    svg: null,
    root: null,
    width: 0,
    height: 0,
    margin: { top: 32, right: 40, bottom: 60, left: 84 },
    xScale: null,
    yScale: null,
    innerW: 0,
    innerH: 0,
    initialized: false,
};

const MESO_SPLIT_YEAR = 2025; // solid up to here, dashed (projected) after

async function loadMesoData() {
    try {
        mesoState.data = await d3.json("docs/modis_data/mesophotic_projection.json");
        const { date, sst } = mesoState.data.data;
        mesoState.series = date.map((d, i) => ({ year: +d, sst: sst[i] }))
            .filter(d => d.year <= 2100);
        console.log("Mesophotic data loaded:", mesoState.series.length, "years");
    } catch (err) {
        console.error("Failed to load mesophotic data:", err);
    }
}

function initMesoChart() {
    if (!mesoState.data) { console.warn("Mesophotic data not loaded yet"); return; }
    if (mesoState.initialized) return;
    const stage = document.getElementById("meso-stage");
    if (!stage) return;

    const rect = stage.getBoundingClientRect();
    mesoState.width = rect.width;
    mesoState.height = rect.height;
    const { width, height, margin } = mesoState;
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;
    mesoState.innerW = innerW;
    mesoState.innerH = innerH;

    const threshold = mesoState.data.threshold;
    const series = mesoState.series;

    mesoState.svg = d3.select(stage).append("svg")
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("preserveAspectRatio", "xMidYMid meet");
    const root = mesoState.svg.append("g")
        .attr("class", "meso-root")
        .attr("transform", `translate(${margin.left},${margin.top})`);
    mesoState.root = root;

    const x = d3.scaleLinear()
        .domain(d3.extent(series, d => d.year))
        .range([0, innerW]);
    const yExt = d3.extent(series, d => d.sst);
    const y = d3.scaleLinear()
        .domain([Math.floor(yExt[0]) - 0.5, Math.ceil(yExt[1]) + 0.5])
        .range([innerH, 0]);
    mesoState.xScale = x;
    mesoState.yScale = y;

    // clip path for the left-to-right line reveal
    mesoState.svg.append("defs")
        .append("clipPath").attr("id", "meso-reveal")
        .append("rect").attr("class", "meso-reveal-rect")
        .attr("x", 0).attr("y", -10)
        .attr("width", 0).attr("height", innerH + 20);

    // 1. danger zone above threshold (hidden until step 1)
    root.append("rect").attr("class", "meso-danger")
        .attr("x", 0).attr("y", 0)
        .attr("width", innerW).attr("height", y(threshold));

    // 2. axes
    root.append("g").attr("class", "meso-axis meso-axis--x")
        .attr("transform", `translate(0,${innerH})`)
        .call(d3.axisBottom(x).ticks(8).tickFormat(d3.format("d")).tickSizeOuter(0));
    root.append("g").attr("class", "meso-axis meso-axis--y")
        .call(d3.axisLeft(y).ticks(6).tickFormat(d => `${d}°`).tickSizeOuter(0));

    root.append("text").attr("class", "meso-axis-label")
        .attr("text-anchor", "middle")
        .attr("transform", `translate(${-margin.left + 26},${innerH / 2}) rotate(-90)`)
        .text("Sea surface temperature (°C)");
    root.append("text").attr("class", "meso-axis-label")
        .attr("text-anchor", "middle")
        .attr("x", innerW / 2).attr("y", innerH + margin.bottom - 18)
        .text("Year");

    // 3. threshold line + label (hidden until step 1)
    root.append("line").attr("class", "meso-threshold-line")
        .attr("x1", 0).attr("x2", innerW)
        .attr("y1", y(threshold)).attr("y2", y(threshold));
    root.append("text").attr("class", "meso-threshold-label")
        .attr("x", 4).attr("y", y(threshold) - 8)
        .attr("text-anchor", "start")
        .text(`mesophotic bleaching threshold: ${threshold}°C`);

    // 4. projection line — solid (observed) then dashed (projected), under the reveal clip
    const lineGen = d3.line().x(d => x(d.year)).y(d => y(d.sst)).curve(d3.curveMonotoneX);
    const observed = series.filter(d => d.year <= MESO_SPLIT_YEAR);
    const projected = series.filter(d => d.year >= MESO_SPLIT_YEAR);
    const linesG = root.append("g").attr("clip-path", "url(#meso-reveal)");
    linesG.append("path").datum(observed)
        .attr("class", "meso-line meso-line--observed").attr("d", lineGen);
    linesG.append("path").datum(projected)
        .attr("class", "meso-line meso-line--projected").attr("d", lineGen);

    // crossing marker — first year the projection reaches the threshold (revealed at step 2)
    const crossing = series.find(d => d.sst >= threshold);
    if (crossing) {
        const cg = root.append("g").attr("class", "meso-crossing");
        cg.append("line").attr("class", "meso-crossing-guide")
            .attr("x1", x(crossing.year)).attr("x2", x(crossing.year))
            .attr("y1", y(crossing.sst)).attr("y2", y(crossing.sst) - 34);
        cg.append("circle").attr("class", "meso-crossing-dot")
            .attr("cx", x(crossing.year)).attr("cy", y(crossing.sst)).attr("r", 5);
        cg.append("text").attr("class", "meso-crossing-label")
            .attr("x", x(crossing.year)).attr("y", y(crossing.sst) - 42)
            .attr("text-anchor", "middle")
            .text(`~${crossing.year}`);
    }

    // hover focus + tooltip
    const focus = root.append("g").attr("class", "meso-focus").style("display", "none");
    focus.append("circle").attr("class", "meso-focus-dot").attr("r", 4);
    mesoState.focus = focus;
    mesoState.bisect = d3.bisector(d => d.year).left;

    if (!document.getElementById("meso-tooltip")) {
        d3.select(stage).append("div").attr("class", "meso-tooltip").attr("id", "meso-tooltip");
    }

    root.append("rect").attr("class", "meso-hit")
        .attr("x", 0).attr("y", 0)
        .attr("width", innerW).attr("height", innerH)
        .attr("fill", "transparent")
        .style("cursor", "crosshair")
        .on("mousemove", mesoHover)
        .on("mouseleave", mesoLeave);

    mesoState.initialized = true;
}

function mesoTransitionTo(stepIdx) {
    if (!mesoState.initialized) initMesoChart();
    if (!mesoState.svg) return;
    const svg = mesoState.svg;
    const set = (sel, vis) => svg.selectAll(sel).classed("is-visible", vis);

    if (stepIdx === 0) {
        set(".meso-threshold-line, .meso-threshold-label", false);
        set(".meso-danger", false);
        set(".meso-crossing", false);
        svg.select(".meso-reveal-rect")
            .interrupt().attr("width", 0)
            .transition().duration(2200).ease(d3.easeCubicInOut)
            .attr("width", mesoState.innerW);
    }

    if (stepIdx === 1) {
        svg.select(".meso-reveal-rect").interrupt().attr("width", mesoState.innerW);
        set(".meso-threshold-line, .meso-threshold-label", true);
        set(".meso-danger", true);
        set(".meso-crossing", false);
    }

    if (stepIdx === 2) {
        svg.select(".meso-reveal-rect").interrupt().attr("width", mesoState.innerW);
        set(".meso-threshold-line, .meso-threshold-label", true);
        set(".meso-danger", true);
        set(".meso-crossing", true);
    }
}

function mesoHover(event) {
    const { xScale: x, yScale: y, series, focus, bisect, root } = mesoState;
    const stage = document.getElementById("meso-stage");
    const tooltip = document.getElementById("meso-tooltip");
    if (!stage || !tooltip) return;
    const [mx] = d3.pointer(event, root.node());
    const year = x.invert(mx);
    const i = bisect(series, year);
    const d0 = series[Math.max(0, i - 1)];
    const d1 = series[Math.min(series.length - 1, i)];
    const d = (!d0 || (d1 && (year - d0.year > d1.year - year))) ? d1 : d0;
    if (!d) return;

    const dot = focus.style("display", null).select(".meso-focus-dot")
        .attr("cx", x(d.year)).attr("cy", y(d.sst));

    tooltip.innerHTML = `
        <span class="meso-tooltip__year">${d.year}</span>
        <span class="meso-tooltip__temp">${d.sst.toFixed(2)}°C</span>
    `;
    tooltip.classList.add("is-visible");

    // anchor to the dot (snaps with the value) instead of the cursor
    const stageRect = stage.getBoundingClientRect();
    const dotRect = dot.node().getBoundingClientRect();
    tooltip.style.left = `${dotRect.left - stageRect.left + dotRect.width / 2 + 12}px`;
    tooltip.style.top = `${dotRect.top - stageRect.top - 12}px`;
}

function mesoLeave() {
    if (mesoState.focus) mesoState.focus.style("display", "none");
    const tooltip = document.getElementById("meso-tooltip");
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

// function handleSSTHover(event) {
//     const tooltip = document.getElementById("sst-tooltip");
//     const stage = document.getElementById("map-stage");
//     if (!tooltip || !stage) return;

//     const year = sstState.currentYear;
//     let html = `<span class="sst-tooltip__year">${year}</span>`;

//     // Get the pixel value at the cursor location
//     const pixelValue = getPixelValueAtCursor(event);

//     if (pixelValue !== null) {
//         // Have per-pixel data
//         if (sstState.mode === "sst") {
//             html += `SST: <span class="sst-tooltip__value">${pixelValue.toFixed(2)}°C</span>`;
//         } else {
//             const sign = pixelValue >= 0 ? "+" : "";
//             html += `Anomaly: <span class="sst-tooltip__value">${sign}${pixelValue.toFixed(2)}°C</span>`;
//         }
//     } else {
//         // Fallback: show the regional mean
//         if (sstState.mode === "sst") {
//             const stats = sstState.metadata?.yearly_stats?.[year];
//             if (stats) {
//                 html += `Mean SST: <span class="sst-tooltip__value">${stats.mean_sst.toFixed(2)}°C</span>`;
//             }
//         } else {
//             const anom = sstState.metadata?.yearly_anomaly?.[year];
//             if (anom) {
//                 const sign = anom.mean_anomaly >= 0 ? "+" : "";
//                 html += `Mean anomaly: <span class="sst-tooltip__value">${sign}${anom.mean_anomaly.toFixed(2)}°C</span>`;
//             }
//         }
//     }

//     tooltip.innerHTML = html;
//     tooltip.classList.add("is-visible");

//     const stageRect = stage.getBoundingClientRect();
//     tooltip.style.left = `${event.clientX - stageRect.left + 12}px`;
//     tooltip.style.top = `${event.clientY - stageRect.top - 12}px`;
// }

function handleSSTHover(event) {
    const tooltip = document.getElementById("sst-tooltip");
    const stage = document.getElementById("map-stage");
    if (!tooltip || !stage) return;

    const year = sstState.currentYear;
    const pixelValue = getPixelValueAtCursor(event);
    const isAnomaly = sstState.mode !== "sst";

    let celsius = null, label = "";
    if (pixelValue !== null) {
        celsius = pixelValue;
        label = isAnomaly ? "Anomaly" : "SST";
    } else if (!isAnomaly) {
        const stats = sstState.metadata?.yearly_stats?.[year];
        if (stats) { celsius = stats.mean_sst; label = "Mean SST"; }
    } else {
        const anom = sstState.metadata?.yearly_anomaly?.[year];
        if (anom) { celsius = anom.mean_anomaly; label = "Mean anomaly"; }
    }

    sstState.lastTooltip = (celsius === null) ? { year } : { year, celsius, isAnomaly, label };
    renderSSTTooltip();

    tooltip.classList.add("is-visible");
    const stageRect = stage.getBoundingClientRect();
    tooltip.style.left = `${event.clientX - stageRect.left + 12}px`;
    tooltip.style.top = `${event.clientY - stageRect.top - 12}px`;
}

function renderSSTTooltip() {
    const tooltip = document.getElementById("sst-tooltip");
    const t = sstState.lastTooltip;
    if (!tooltip || !t) return;
    let html = `<span class="sst-tooltip__year">${t.year}</span>`;
    if (t.celsius !== undefined) {
        const val = convertTemp(t.celsius, t.isAnomaly);
        const sign = t.isAnomaly && val >= 0 ? "+" : "";
        html += `${t.label}: <span class="sst-tooltip__value">${sign}${val.toFixed(2)}${unitSymbol()}</span>`;
    }
    tooltip.innerHTML = html;
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

function initSSTUnitToggle() {
    const btns = document.querySelectorAll(".sst-unit-btn");
    if (!btns.length) return;
    btns.forEach(btn => {
        btn.addEventListener("click", () => {
            sstState.unit = btn.dataset.unit;
            document.querySelectorAll(".sst-unit-btn").forEach(b =>
                b.classList.toggle("is-active", b.dataset.unit === sstState.unit));
            updateLegend();

            // refresh an open tooltip so it flips units immediately
            const tt = document.getElementById("sst-tooltip");
            if (tt && tt.classList.contains("is-visible")) renderSSTTooltip();
        });
    });
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
    const u = unitSymbol();
    const sstLo = sstState.unit === "F" ? Math.round(convertTemp(22, false)) : 22;
    const sstHi = sstState.unit === "F" ? Math.round(convertTemp(32, false)) : 32;

    // step-2 legend — always the SST scale
    const s2min = document.getElementById("sst-legend-step2-min");
    const s2max = document.getElementById("sst-legend-step2-max");
    if (s2min) s2min.textContent = `${sstLo}${u}`;
    if (s2max) s2max.textContent = `${sstHi}${u}`;

    // step-3 legend — SST or anomaly depending on mode
    const bar = document.getElementById("sst-legend-bar");
    const minLabel = document.getElementById("sst-legend-min");
    const maxLabel = document.getElementById("sst-legend-max");
    if (!bar || !minLabel || !maxLabel) return;
    if (sstState.mode === "sst") {
        bar.classList.remove("is-anomaly");
        bar.classList.add("is-sst");
        minLabel.textContent = `${sstLo}${u}`;
        maxLabel.textContent = `${sstHi}${u}`;
    } else {
        bar.classList.remove("is-sst");
        bar.classList.add("is-anomaly");
        const mag = sstState.unit === "F" ? convertTemp(2.5, true).toFixed(1) : "2.5";
        minLabel.textContent = `−${mag}${u}`;
        maxLabel.textContent = `+${mag}${u}`;
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
/*  REEF EXPLORER — final "every reef" section    */
/* ============================================ */

const REEF_META_URL = "docs/modis_data/reefs_metadata.json"; // >>> adjust to your committed path
const REEF_WORLD_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/land-110m.json";

const reefState = {
    svg: null, g: null, projection: null, path: null,
    width: 0, height: 0,
    land: null, overlays: null, dots: null, tooltip: null,
    meta: null, mode: "sst", year: 2022,
};

async function initReefExplore() {
    const stage = document.getElementById("reef-map");
    if (!stage) return;

    wireReefGuesser();
    wireReefControls();

    stage.textContent = "";
    const rect = stage.getBoundingClientRect();
    reefState.width = rect.width;
    reefState.height = rect.height || 420;

    reefState.svg = d3.select(stage).append("svg")
        .attr("viewBox", `0 0 ${reefState.width} ${reefState.height}`)
        .attr("preserveAspectRatio", "xMidYMid meet");
    reefState.g = reefState.svg.append("g").attr("class", "reef-map-root");

    reefState.projection = d3.geoNaturalEarth1()
        .scale(reefState.width / 6.2)
        .translate([reefState.width / 2, reefState.height / 2])
        .center([0, 10]);
    reefState.path = d3.geoPath().projection(reefState.projection);

    reefState.overlays = reefState.g.append("g").attr("class", "reef-overlays");
    reefState.land = reefState.g.append("g").attr("class", "reef-land");
    reefState.spotlight = reefState.g.append("g").attr("class", "reef-spotlight");
    reefState.dots = reefState.g.append("g").attr("class", "reef-dots");

    // Ocean rect behind everything — same class as your global map
    reefState.g.insert("rect", ":first-child")
        .attr("class", "map-ocean")
        .attr("width", reefState.width)
        .attr("height", reefState.height);

    // Graticule — same as global map (keep a reference so we can hide it on zoom)
    const graticule = d3.geoGraticule().step([20, 20]);
    reefState.graticule = reefState.g.insert("path", ".reef-land")
        .datum(graticule())
        .attr("class", "map-graticule")
        .attr("d", reefState.path);

    reefState.tooltip = d3.select("body").append("div")
        .attr("class", "reef-tooltip")
        .style("position", "fixed")
        .style("pointer-events", "none")
        .style("z-index", "9999")
        .style("opacity", 0);

    // Remember the world view so we can return to it
    reefState.home = {
        scale: reefState.projection.scale(),
        translate: reefState.projection.translate().slice(),
    };

    // label and back-button
    const box = d3.select(stage.parentNode);
    reefState.bar = box.insert("div", "#reef-map").attr("class", "reef-bar");  // no display:none
    reefState.label = reefState.bar.append("span").attr("class", "reef-label").text("All reefs - global view");
    reefState.backBtn = reefState.bar.append("button")
        .attr("class", "reef-back").attr("type", "button")
        .text("← Back to world map").style("display", "none").on("click", zoomOutReef);

    try {
        const [world, meta] = await Promise.all([
            d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json"),  // was 110m  // countries, like your global map
            d3.json(REEF_META_URL),
        ]);
        reefState.meta = meta;
        reefState.land.append("path")
            .datum(topojson.feature(world, world.objects.countries))
            .attr("class", "map-land")     // <-- your existing sand-colored land style
            .attr("d", reefState.path);
        drawReefDots();
        renderReefLayer();
    } catch (err) {
        console.error("initReefExplore: load failed", err);
    }
}

function drawReefDots() {
    reefState.dots.selectAll(".reef-dot")
        .data(reefState.meta.reefs)
        .join("circle")
        .attr("class", "reef-dot")
        .attr("cx", d => reefState.projection([d.lon, d.lat])[0])
        .attr("cy", d => reefState.projection([d.lon, d.lat])[1])
        .attr("r", d => d.size)
        .on("mousemove", showReefTip)
        .on("mouseleave", hideReefTip)
        .on("click", (e, d) => zoomToReef(d));
}

function showReefTip(event, d) {
    console.log("TIP fired:", d.name, event.clientX, event.clientY);   // remove once confirmed
    const y = d.yearly && d.yearly[String(reefState.year)];
    let val = "—";
    if (y) val = reefState.mode === "sst"
        ? `${y.mean_sst}°C`
        : `${y.mean_anomaly >= 0 ? "+" : ""}${y.mean_anomaly}°C`;
    reefState.tooltip
        .style("opacity", 1)
        .html(`<strong>${d.name}</strong><br>${reefState.year} · ${reefState.mode === "sst" ? "SST" : "anomaly"}: ${val}`)
        .style("left", `${event.clientX + 14}px`)
        .style("top", `${event.clientY + 14}px`);
}
function hideReefTip() { reefState.tooltip.style("opacity", 0); }

function zoomToReef(reef) {
    const b = reef.bbox;

    // Project the four corners directly — avoids d3-geo's spherical-polygon
    // winding rule (which was measuring "the whole globe minus the box").
    const pts = [
        reefState.projection([b.lon_min, b.lat_min]),
        reefState.projection([b.lon_max, b.lat_min]),
        reefState.projection([b.lon_max, b.lat_max]),
        reefState.projection([b.lon_min, b.lat_max]),
    ];
    const xs = pts.map(p => p[0]);
    const ys = pts.map(p => p[1]);
    const boxW = Math.max(...xs) - Math.min(...xs);
    const boxH = Math.max(...ys) - Math.min(...ys);
    if (!(boxW > 0) || !(boxH > 0)) { console.warn("bad bbox for", reef.name, b); return; }

    const fill = 0.85;
    const k = Math.min((reefState.width * fill) / boxW, (reefState.height * fill) / boxH);

    // 1) scale up
    reefState.projection.scale(reefState.projection.scale() * k);
    // 2) re-center: project the reef centre, then shift translate so it lands at viewport centre
    const center = [(b.lon_min + b.lon_max) / 2, (b.lat_min + b.lat_max) / 2];
    const [px, py] = reefState.projection(center);
    const [tx, ty] = reefState.projection.translate();
    reefState.projection.translate([tx + (reefState.width / 2 - px), ty + (reefState.height / 2 - py)]);

    reefState.path = d3.geoPath().projection(reefState.projection);  // refresh path
    redrawReef();

    reefState.graticule.style("display", "none");
    reefState.label.text(reef.name);
    reefState.backBtn.style("display", "inline-block");
    reefState.dots.selectAll(".reef-dot")
        .style("display", d => d.name === reef.name ? "none" : null);

    reefState.focused = reef;
    renderReefLayer();
}

function zoomOutReef() {
    reefState.projection
        .scale(reefState.home.scale)
        .translate(reefState.home.translate);
    reefState.path = d3.geoPath().projection(reefState.projection);

    redrawReef();
    reefState.graticule.attr("d", reefState.path).style("display", null);
    reefState.label.text("All reefs - global view");
    reefState.backBtn.style("display", "none");
    reefState.dots.selectAll(".reef-dot").style("display", null);
    reefState.focused = null;
    reefState.overlays.selectAll("*").remove();
    reefState.spotlight.selectAll("*").remove();
    reefState.pixelData = null;
    reefState.pixelKey = null;
}

function redrawReef() {
    reefState.land.select("path").attr("d", reefState.path);
    reefState.dots.selectAll(".reef-dot")
        .attr("cx", d => reefState.projection([d.lon, d.lat])[0])
        .attr("cy", d => reefState.projection([d.lon, d.lat])[1]);
    if (reefState.focused) renderReefLayer();
}

function renderReefLayer() {
    if (!reefState.meta) return;
    reefState.dots.selectAll(".reef-dot").classed("reef-dot--anom", reefState.mode === "anomaly");

    const reef = reefState.focused;
    if (!reef) {
        reefState.overlays.selectAll("*").remove();
        reefState.spotlight.selectAll("*").remove();
        return;
    }

    const b = reef.bbox, proj = reefState.projection;
    const tl = proj([b.lon_min, b.lat_max]);
    const br = proj([b.lon_max, b.lat_min]);
    const imgX = tl[0], imgY = tl[1], imgW = br[0] - tl[0], imgH = br[1] - tl[1];

    // Build the path from the slug (no reliance on reef.sst_png)
    const kind = reefState.mode === "sst" ? "sst" : "anomaly";
    const href = `docs/modis_data/${kind}_${reef.slug}_${reefState.year}.png`;
    console.log("overlay href:", href);   // <-- check this in the console, then remove

    // data layer (below land): white no-data backing + the SST/anomaly image
    reefState.overlays.selectAll("*").remove();
    reefState.overlays.append("rect")
        .attr("class", "sst-nodata-bg")
        .attr("x", imgX).attr("y", imgY).attr("width", imgW).attr("height", imgH)
        .attr("fill", "white");
    reefState.overlays.append("image")
        .attr("class", "sst-image is-visible")
        .attr("href", href)
        .attr("x", imgX).attr("y", imgY).attr("width", imgW).attr("height", imgH)
        .attr("preserveAspectRatio", "none");

    // dim everything OUTSIDE the box — same wash as the GBR spotlight
    let defs = reefState.svg.select("defs");
    if (defs.empty()) defs = reefState.svg.append("defs");
    defs.select("#reef-spotlight-mask").remove();
    const mask = defs.append("mask").attr("id", "reef-spotlight-mask");
    mask.append("rect").attr("width", "100%").attr("height", "100%").attr("fill", "white");
    mask.append("rect").attr("x", imgX).attr("y", imgY).attr("width", imgW).attr("height", imgH).attr("fill", "black");
    const vb = reefState.svg.attr("viewBox").split(/\s+/).map(Number);
    reefState.spotlight.selectAll("*").remove();
    reefState.spotlight.append("rect")
        .attr("class", "spotlight-overlay is-visible")
        .attr("x", vb[0]).attr("y", vb[1]).attr("width", vb[2]).attr("height", vb[3])
        .attr("mask", "url(#reef-spotlight-mask)")
        .style("pointer-events", "none");

    reefState.overlays.append("rect")
        .attr("class", "reef-hit")
        .attr("x", imgX).attr("y", imgY).attr("width", imgW).attr("height", imgH)
        .attr("fill", "transparent")
        .style("cursor", "crosshair")
        .on("mousemove", handleReefPixelHover)
        .on("mouseleave", hideReefTip);

    loadReefPixelData();   // fetch the values for this reef/mode/year
}

function updateReefLegend() {
    const u = unitSymbol();
    const bar = document.getElementById("reef-legend-bar");
    const lo = document.getElementById("reef-legend-min");
    const hi = document.getElementById("reef-legend-max");
    if (!bar || !lo || !hi) return;
    if (reefState.mode === "sst") {
        bar.classList.remove("is-anomaly"); bar.classList.add("is-sst");
        lo.textContent = `${Math.round(convertTemp(22, false))}${u}`;
        hi.textContent = `${Math.round(convertTemp(32, false))}${u}`;
    } else {
        bar.classList.remove("is-sst"); bar.classList.add("is-anomaly");
        const mag = sstState.unit === "F" ? convertTemp(2.5, true).toFixed(1) : "2.5";
        lo.textContent = `−${mag}${u}`;
        hi.textContent = `+${mag}${u}`;
    }
}

function wireReefControls() {
    const yearInput = document.getElementById("reef-year");
    const yearOut = document.getElementById("reef-year-out");
    const sstBtn = document.getElementById("reef-mode-sst");
    const anomBtn = document.getElementById("reef-mode-anom");

    if (yearInput) yearInput.addEventListener("input", () => {
        reefState.year = +yearInput.value;
        yearOut.textContent = reefState.year;
        renderReefLayer();
    });
    if (sstBtn) sstBtn.addEventListener("click", () => setReefMode("sst"));
    if (anomBtn) anomBtn.addEventListener("click", () => setReefMode("anomaly"));

    document.querySelectorAll(".reef-unit button").forEach(btn => {
        btn.addEventListener("click", () => {
            sstState.unit = btn.dataset.unit;                 // shared with GBR helpers
            document.querySelectorAll(".reef-unit button").forEach(b =>
                b.classList.toggle("is-active", b.dataset.unit === sstState.unit));
            updateReefLegend();
        });
    });
    updateReefLegend();
}

function setReefMode(next) {
    reefState.mode = next;
    document.getElementById("reef-mode-sst").setAttribute("aria-pressed", String(next === "sst"));
    document.getElementById("reef-mode-anom").setAttribute("aria-pressed", String(next === "anomaly"));
    renderReefLayer();

    if (y) {
        const c = reefState.mode === "sst" ? y.mean_sst : y.mean_anomaly;
        const v = convertTemp(c, reefState.mode === "anomaly");
        const sign = (reefState.mode === "anomaly" && v >= 0) ? "+" : "";
        val = `${sign}${v.toFixed(2)}${unitSymbol()}`;
    }
}

async function loadReefPixelData() {
    const reef = reefState.focused;
    if (!reef) { reefState.pixelData = null; reefState.pixelKey = null; return; }
    const kind = reefState.mode === "sst" ? "sst" : "anomaly";
    const key = `${reef.slug}_${kind}_${reefState.year}`;
    if (reefState.pixelKey === key) return;            // already loaded
    const path = `docs/modis_data/${kind}_${reef.slug}_${reefState.year}.json`;
    try {
        reefState.pixelData = await d3.json(path);
        reefState.pixelKey = key;
    } catch (err) {
        console.warn("Reef pixel data not found:", path);
        reefState.pixelData = null;
        reefState.pixelKey = null;
    }
}

function getReefPixelValue(event) {
    if (!reefState.pixelData || !reefState.focused) return null;
    const svg = reefState.svg.node();
    const pt = svg.createSVGPoint();
    pt.x = event.clientX; pt.y = event.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    const [lon, lat] = reefState.projection.invert([p.x, p.y]);

    const b = reefState.focused.bbox;
    if (lon < b.lon_min || lon > b.lon_max || lat < b.lat_min || lat > b.lat_max) return null;

    const [nLat, nLon] = reefState.pixelData.shape;
    const latFrac = (b.lat_max - lat) / (b.lat_max - b.lat_min);  // lat runs high→low
    const lonFrac = (lon - b.lon_min) / (b.lon_max - b.lon_min);
    const latIdx = Math.floor(latFrac * nLat);
    const lonIdx = Math.floor(lonFrac * nLon);
    if (latIdx < 0 || latIdx >= nLat || lonIdx < 0 || lonIdx >= nLon) return null;

    return reefState.pixelData.values[latIdx * nLon + lonIdx];  // null = no-data pixel
}

function handleReefPixelHover(event) {
    const reef = reefState.focused;
    if (!reef) return;
    const isAnom = reefState.mode !== "sst";
    const v = getReefPixelValue(event);

    let body;
    if (v !== null && v !== undefined) {
        const t = convertTemp(v, isAnom);
        const sign = isAnom && t >= 0 ? "+" : "";
        body = `${isAnom ? "Anomaly" : "SST"}: <strong>${sign}${t.toFixed(2)}${unitSymbol()}</strong>`;
    } else {
        body = `<span style="opacity:.7">no data here</span>`;   // land / cloud pixel
    }

    reefState.tooltip
        .style("opacity", 1)
        .html(`<strong>${reef.name}</strong> · ${reefState.year}<br>${body}`)
        .style("left", `${event.clientX + 14}px`)
        .style("top", `${event.clientY + 14}px`);
}

/* ============================================ */
/*  REEF BLEACHING GUESSER                      */
/* ============================================ */

function drawCoral(parent, cx, baseY, h, color) {
    const g = parent.append("g").attr("transform", `translate(${cx},${baseY})`);
    const branches = [{ a: -30, l: 0.6 }, { a: -16, l: 0.92 }, { a: -4, l: 1 }, { a: 8, l: 0.95 }, { a: 22, l: 0.72 }, { a: 34, l: 0.55 }];
    const w = Math.max(4, h * 0.14);
    branches.forEach(b => {
        const rad = b.a * Math.PI / 180, len = h * b.l;
        const x2 = Math.sin(rad) * len, y2 = -Math.cos(rad) * len;
        g.append("line").attr("x1", 0).attr("y1", 0).attr("x2", x2).attr("y2", y2)
            .attr("stroke", color).attr("stroke-width", w).attr("stroke-linecap", "round");
        g.append("circle").attr("cx", x2).attr("cy", y2).attr("r", w * 0.7).attr("fill", color);
    });
}

function wireReefGuesser() {
    const ANSWER = 84;                 // % of world reefs hit (ICRI/NOAA, Apr 2025)
    const W = 600, H = 200, BASE = 165;
    const CORAL = "#ff7058";           // healthy
    const BLEACH = "#ffffff";          // bleached skeleton

    const scene = d3.select("#guesser-scene");
    if (scene.empty()) return;
    scene.selectAll("*").remove();
    const svg = scene.append("svg")
        .attr("viewBox", `0 0 ${W} ${H}`)
        .attr("preserveAspectRatio", "xMidYMid meet");

    const defs = svg.append("defs");
    const clipRect = defs.append("clipPath").attr("id", "bleach-clip")
        .append("rect").attr("x", 0).attr("y", 0).attr("width", 0).attr("height", H);

    // seabed
    svg.append("line").attr("x1", 0).attr("y1", BASE + 2).attr("x2", W).attr("y2", BASE + 2)
        .attr("stroke", "#cfe8ef").attr("stroke-width", 3);

    const corals = [
        { x: 30, h: 56 }, { x: 72, h: 90 }, { x: 112, h: 50 },
        { x: 152, h: 100 }, { x: 196, h: 64 }, { x: 238, h: 86 },
        { x: 280, h: 52 }, { x: 320, h: 96 }, { x: 362, h: 68 },
        { x: 404, h: 88 }, { x: 444, h: 56 }, { x: 486, h: 94 },
        { x: 526, h: 66 }, { x: 566, h: 50 },
    ];

    const healthy = svg.append("g");
    const bleached = svg.append("g").attr("clip-path", "url(#bleach-clip)");
    corals.forEach(c => drawCoral(healthy, c.x, BASE, c.h, CORAL));
    corals.forEach(c => drawCoral(bleached, c.x, BASE, c.h, BLEACH));

    // divider line marking the bleach front
    const divider = svg.append("line").attr("y1", 8).attr("y2", BASE + 8)
        .attr("x1", 0).attr("x2", 0)
        .attr("stroke", "#04546b").attr("stroke-width", 2).attr("stroke-dasharray", "4 3");

    const slider = document.getElementById("reef-guess");
    const valOut = document.getElementById("reef-guess-val");
    const submit = document.getElementById("reef-guess-submit");
    const reveal = document.getElementById("reef-guess-reveal");
    const msg = document.getElementById("reef-guess-msg");

    function setPct(pct) {
        const x = (pct / 100) * W;
        clipRect.attr("width", x);
        divider.attr("x1", x).attr("x2", x);
        valOut.textContent = Math.round(pct);
    }
    setPct(0);

    if (slider) slider.addEventListener("input", () => setPct(+slider.value));

    if (submit) submit.addEventListener("click", () => {
        const guess = +slider.value;
        d3.transition().duration(900).ease(d3.easeCubicInOut).tween("ans", () => {
            const i = d3.interpolateNumber(guess, ANSWER);
            return t => { const p = i(t); if (slider) slider.value = p; setPct(p); };
        });
        const diff = guess - ANSWER;
        let verdict;
        if (Math.abs(diff) <= 3)
            verdict = `Spot on. You guessed ${guess}% — and about <strong>${ANSWER}%</strong> of the world's reefs have been hit by bleaching since 2023.`;
        else if (diff < 0)
            verdict = `You guessed ${guess}%. It's even worse: about <strong>${ANSWER}%</strong> of the world's reefs have been hit, making the current global event the most widespread and intense mass bleaching crisis recorded.`;
        else
            verdict = `You guessed ${guess}%. It's not quite that high, but still a staggering amount: about <strong>${ANSWER}%</strong> of the world's reefs have been hit.`;
        msg.innerHTML = verdict;
        reveal.hidden = false;
    });
}

/* ============================================ */
/*  STRESS CARDS MODULE                         */
/*  Drop into global.js beside other modules    */
/* ============================================ */
const StressModule = (function () {

    const DATA = {
        2016: { sst: 27.774, chl: 0.1875, adg: 0.011209 },
        2022: { sst: 27.885, chl: 0.21662, adg: 0.012847 }
    };
    const LTM = { sst: 26.877, chl: 0.19507, adg: 0.011879 };
    // scale ceilings — bar reaches 100% at these values
    const MAX = { sst: 28.5, chl: 0.26, adg: 0.0158 };

    const INDICATORS = [
        { key: 'sst', label: 'Sea surface temp.', unit: '°C', decimals: 2, color: 'var(--c-coral)' },
        { key: 'chl', label: 'Chlorophyll-a', unit: 'mg m⁻³', decimals: 4, color: '#2a8a5e' },
        { key: 'adg', label: 'Dissolved organics a_dg', unit: 'm⁻¹', decimals: 5, color: '#c47a1e' }
    ];

    function pctAbove(val, mean) {
        return ((val - mean) / mean * 100).toFixed(1);
    }
    function barW(val, max) {
        return Math.min(100, (val / max) * 100).toFixed(2);
    }
    function meanW(mean, max) {
        return Math.min(100, (mean / max) * 100).toFixed(2);
    }

    function buildCard(year) {
        const d = DATA[year];
        const rows = INDICATORS.map(ind => {
            const val = d[ind.key];
            const pct = pctAbove(val, LTM[ind.key]);
            const above = parseFloat(pct) > 0;
            const sign = above ? '+' : '';
            return `
        <div class="stress-row" data-key="${ind.key}">
          <div class="stress-row__header">
            <span class="stress-row__label">${ind.label}</span>
            <span class="stress-row__value">${val.toFixed(ind.decimals)} ${ind.unit}</span>
          </div>
          <div class="stress-bar__track">
            <div class="stress-bar__fill"
                 data-target="${barW(val, MAX[ind.key])}"
                 style="width:0%;background:${ind.color};"></div>
            <div class="stress-bar__mean"
                 style="left:${meanW(LTM[ind.key], MAX[ind.key])}%;"></div>
          </div>
          <div class="stress-row__caption ${above ? 'is-above' : 'is-below'}">
            ${sign}${pct}% vs. 20-year average
          </div>
        </div>`;
        }).join('');

        return `
      <div class="stress-card" id="stress-card-${year}">
        <div class="stress-card__year ${year === 2022 ? 'stress-card__year--hot' : ''}">${year}</div>
        ${rows}
      </div>`;
    }

    function animateBars(cardEl) {
        cardEl.querySelectorAll('.stress-bar__fill').forEach((bar, i) => {
            setTimeout(() => {
                bar.style.transition = 'width 0.85s cubic-bezier(0.4,0,0.2,1)';
                bar.style.width = bar.dataset.target + '%';
            }, i * 200);
        });
        cardEl.querySelectorAll('.stress-bar__mean').forEach((m, i) => {
            setTimeout(() => m.classList.add('is-visible'), i * 200 + 700);
        });
    }

    function resetBars(cardEl) {
        cardEl.querySelectorAll('.stress-bar__fill').forEach(bar => {
            bar.style.transition = 'none';
            bar.style.width = '0%';
        });
        cardEl.querySelectorAll('.stress-bar__mean').forEach(m => {
            m.classList.remove('is-visible');
        });
        cardEl.querySelectorAll('.stress-row').forEach(r => {
            r.classList.remove('is-highlighted');
        });
    }

    let currentStep = -1;

    function transitionTo(stepIdx) {
        if (stepIdx === currentStep) return;
        currentStep = stepIdx;

        const card16 = document.getElementById('stress-card-2016');
        const card22 = document.getElementById('stress-card-2022');
        if (!card16 || !card22) return;

        if (stepIdx === 0) {
            card22.classList.remove('is-visible');
            resetBars(card16);
            card16.classList.add('is-visible');
            setTimeout(() => animateBars(card16), 120);
        }

        if (stepIdx === 1) {
            card16.classList.add('is-visible');
            card22.classList.add('is-visible');
            resetBars(card22);
            setTimeout(() => animateBars(card22), 120);
            card22.querySelectorAll('.stress-row').forEach(row => {
                const caption = row.querySelector('.stress-row__caption');
                if (caption && caption.classList.contains('is-above')) {
                    row.classList.add('is-highlighted');
                }
            });
        }
    }

    function init() {
        const stage = document.getElementById('stress-stage');
        if (!stage) return;
        stage.innerHTML = `
      <div class="stress-cards-wrap">
        ${buildCard(2016)}
        ${buildCard(2022)}
      </div>`;
    }

    return { init, transitionTo };
})();

function initIndicatorCards() {
    document.querySelectorAll('.ind-card').forEach(card => {
        card.addEventListener('click', () => {
            card.classList.toggle('is-open');
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
        loadMicroVarData(),
        loadMesoData(),
    ]).then(() => {
        initMap();
        initScrollytelling();
        initSSTControls();
        initSSTUnitToggle();
        initEffectCards();
        initBleachToggle();
        initMicroVarControls();
        initReefExplore();
        StressModule.init();
        initIndicatorCards();
    });
});
