import { isToday } from "date-fns";
import type {
  Circle,
  CircleMarker,
  LatLngExpression,
  LatLngTuple,
  Layer,
  Map,
  Marker,
  Polyline,
} from "leaflet";
import { CSSResultGroup, PropertyValues, ReactiveElement, css } from "lit";
import { customElement, property, state } from "lit/decorators";
import { formatDateTime } from "../../common/datetime/format_date_time";
import {
  formatTimeWeekday,
  formatTimeWithSeconds,
} from "../../common/datetime/format_time";
import {
  LeafletModuleType,
  setupLeafletMap,
} from "../../common/dom/setup-leaflet-map";
import { computeStateDomain } from "../../common/entity/compute_state_domain";
import { computeStateName } from "../../common/entity/compute_state_name";
import { HomeAssistant, ThemeMode } from "../../types";
import { isTouch } from "../../util/is_touch";
import "../ha-icon-button";
import "./ha-entity-marker";

const getEntityId = (entity: string | HaMapEntity): string =>
  typeof entity === "string" ? entity : entity.entity_id;

export interface HaMapPathPoint {
  point: LatLngTuple;
  timestamp: Date;
}
export interface HaMapPaths {
  points: HaMapPathPoint[];
  color?: string;
  name?: string;
  gradualOpacity?: number;
  fullDatetime?: boolean;
}

export interface HaMapEntity {
  entity_id: string;
  color: string;
  label_mode?: "name" | "state";
  name?: string;
  focus?: boolean;
}

@customElement("ha-map")
export class HaMap extends ReactiveElement {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @property({ attribute: false }) public entities?: string[] | HaMapEntity[];

  @property({ attribute: false }) public paths?: HaMapPaths[];

  @property({ attribute: false }) public layers?: Layer[];

  @property({ type: Boolean }) public autoFit = false;

  @property({ type: Boolean }) public renderPassive = false;

  @property({ type: Boolean }) public interactiveZones = false;

  @property({ type: Boolean }) public fitZones = false;

  @property({ attribute: "theme-mode", type: String })
  public themeMode: ThemeMode = "auto";

  @property({ type: Number }) public zoom = 14;

  @state() private _loaded = false;

  public leafletMap?: Map;

  private Leaflet?: LeafletModuleType;

  private _resizeObserver?: ResizeObserver;

  private _mapItems: Array<Marker | Circle> = [];

  private _mapFocusItems: Array<Marker | Circle> = [];

  private _mapZones: Array<Marker | Circle> = [];

  private _mapPaths: Array<Polyline | CircleMarker> = [];

  public connectedCallback(): void {
    super.connectedCallback();
    this._loadMap();
    this._attachObserver();
  }

  public disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.leafletMap) {
      this.leafletMap.remove();
      this.leafletMap = undefined;
      this.Leaflet = undefined;
    }

    this._loaded = false;

    if (this._resizeObserver) {
      this._resizeObserver.unobserve(this);
    }
  }

  protected update(changedProps: PropertyValues) {
    super.update(changedProps);

    if (!this._loaded) {
      return;
    }
    let autoFitRequired = false;
    const oldHass = changedProps.get("hass") as HomeAssistant | undefined;

    if (changedProps.has("_loaded") || changedProps.has("entities")) {
      this._drawEntities();
      autoFitRequired = true;
    } else if (this._loaded && oldHass && this.entities) {
      // Check if any state has changed
      for (const entity of this.entities) {
        if (
          oldHass.states[getEntityId(entity)] !==
          this.hass!.states[getEntityId(entity)]
        ) {
          this._drawEntities();
          autoFitRequired = true;
          break;
        }
      }
    }

    if (changedProps.has("_loaded") || changedProps.has("paths")) {
      this._drawPaths();
    }

    if (changedProps.has("_loaded") || changedProps.has("layers")) {
      this._drawLayers(changedProps.get("layers") as Layer[] | undefined);
      autoFitRequired = true;
    }

    if (changedProps.has("_loaded") || (this.autoFit && autoFitRequired)) {
      this.fitMap();
    }

    if (changedProps.has("zoom")) {
      this.leafletMap!.setZoom(this.zoom);
    }

    if (
      !changedProps.has("themeMode") &&
      (!changedProps.has("hass") ||
        (oldHass && oldHass.themes?.darkMode === this.hass.themes?.darkMode))
    ) {
      return;
    }
    this._updateMapStyle();
  }

  private get _darkMode() {
    return (
      this.themeMode === "dark" ||
      (this.themeMode === "auto" && Boolean(this.hass.themes.darkMode))
    );
  }

  private _updateMapStyle(): void {
    const map = this.renderRoot.querySelector("#map");
    map!.classList.toggle("dark", this._darkMode);
    map!.classList.toggle("forced-dark", this.themeMode === "dark");
    map!.classList.toggle("forced-light", this.themeMode === "light");
  }

  private _loading = false;

  private async _loadMap(): Promise<void> {
    if (this._loading) return;
    let map = this.shadowRoot!.getElementById("map");
    if (!map) {
      map = document.createElement("div");
      map.id = "map";
      this.shadowRoot!.append(map);
    }
    this._loading = true;
    try {
      [this.leafletMap, this.Leaflet] = await setupLeafletMap(map);
      this._updateMapStyle();
      this._loaded = true;
    } finally {
      this._loading = false;
    }
  }

  public fitMap(options?: { zoom?: number; pad?: number }): void {
    if (!this.leafletMap || !this.Leaflet || !this.hass) {
      return;
    }

    if (!this._mapFocusItems.length && !this.layers?.length) {
      this.leafletMap.setView(
        new this.Leaflet.LatLng(
          this.hass.config.latitude,
          this.hass.config.longitude
        ),
        options?.zoom || this.zoom
      );
      return;
    }

    let bounds = this.Leaflet.latLngBounds(
      this._mapFocusItems
        ? this._mapFocusItems.map((item) => item.getLatLng())
        : []
    );

    if (this.fitZones) {
      this._mapZones?.forEach((zone) => {
        bounds.extend(
          "getBounds" in zone ? zone.getBounds() : zone.getLatLng()
        );
      });
    }

    this.layers?.forEach((layer: any) => {
      bounds.extend(
        "getBounds" in layer ? layer.getBounds() : layer.getLatLng()
      );
    });

    bounds = bounds.pad(options?.pad ?? 0.5);

    this.leafletMap.fitBounds(bounds, { maxZoom: options?.zoom || this.zoom });
  }

  public fitBounds(
    boundingbox: LatLngExpression[],
    options?: { zoom?: number; pad?: number }
  ) {
    if (!this.leafletMap || !this.Leaflet || !this.hass) {
      return;
    }
    const bounds = this.Leaflet.latLngBounds(boundingbox).pad(
      options?.pad ?? 0.5
    );
    this.leafletMap.fitBounds(bounds, { maxZoom: options?.zoom || this.zoom });
  }

  private _drawLayers(prevLayers: Layer[] | undefined): void {
    if (prevLayers) {
      prevLayers.forEach((layer) => layer.remove());
    }
    if (!this.layers) {
      return;
    }
    const map = this.leafletMap!;
    this.layers.forEach((layer) => {
      map.addLayer(layer);
    });
  }

  private _computePathTooltip(path: HaMapPaths, point: HaMapPathPoint): string {
    let formattedTime: string;
    if (path.fullDatetime) {
      formattedTime = formatDateTime(
        point.timestamp,
        this.hass.locale,
        this.hass.config
      );
    } else if (isToday(point.timestamp)) {
      formattedTime = formatTimeWithSeconds(
        point.timestamp,
        this.hass.locale,
        this.hass.config
      );
    } else {
      formattedTime = formatTimeWeekday(
        point.timestamp,
        this.hass.locale,
        this.hass.config
      );
    }
    return `${path.name}<br>${formattedTime}`;
  }

  private _drawPaths(): void {
    const hass = this.hass;
    const map = this.leafletMap;
    const Leaflet = this.Leaflet;

    if (!hass || !map || !Leaflet) {
      return;
    }
    if (this._mapPaths.length) {
      this._mapPaths.forEach((marker) => marker.remove());
      this._mapPaths = [];
    }
    if (!this.paths) {
      return;
    }

    const darkPrimaryColor = getComputedStyle(this).getPropertyValue(
      "--dark-primary-color"
    );

    this.paths.forEach((path) => {
      let opacityStep: number;
      let baseOpacity: number;
      if (path.gradualOpacity) {
        opacityStep = path.gradualOpacity / (path.points.length - 2);
        baseOpacity = 1 - path.gradualOpacity;
      }

      for (
        let pointIndex = 0;
        pointIndex < path.points.length - 1;
        pointIndex++
      ) {
        const opacity = path.gradualOpacity
          ? baseOpacity! + pointIndex * opacityStep!
          : undefined;

        // DRAW point
        this._mapPaths.push(
          Leaflet!
            .circleMarker(path.points[pointIndex].point, {
              radius: isTouch ? 8 : 3,
              color: path.color || darkPrimaryColor,
              opacity,
              fillOpacity: opacity,
              interactive: true,
            })
            .bindTooltip(
              this._computePathTooltip(path, path.points[pointIndex]),
              { direction: "top" }
            )
        );

        // DRAW line between this and next point
        this._mapPaths.push(
          Leaflet!.polyline(
            [path.points[pointIndex].point, path.points[pointIndex + 1].point],
            {
              color: path.color || darkPrimaryColor,
              opacity,
              interactive: false,
            }
          )
        );
      }
      const pointIndex = path.points.length - 1;
      if (pointIndex >= 0) {
        const opacity = path.gradualOpacity
          ? baseOpacity! + pointIndex * opacityStep!
          : undefined;
        // DRAW end path point
        this._mapPaths.push(
          Leaflet!
            .circleMarker(path.points[pointIndex].point, {
              radius: isTouch ? 8 : 3,
              color: path.color || darkPrimaryColor,
              opacity,
              fillOpacity: opacity,
              interactive: true,
            })
            .bindTooltip(
              this._computePathTooltip(path, path.points[pointIndex]),
              { direction: "top" }
            )
        );
      }
      this._mapPaths.forEach((marker) => map.addLayer(marker));
    });
  }

  private _drawEntities(): void {
    const hass = this.hass;
    const map = this.leafletMap;
    const Leaflet = this.Leaflet;

    if (!hass || !map || !Leaflet) {
      return;
    }

    if (this._mapItems.length) {
      this._mapItems.forEach((marker) => marker.remove());
      this._mapItems = [];
      this._mapFocusItems = [];
    }

    if (this._mapZones.length) {
      this._mapZones.forEach((marker) => marker.remove());
      this._mapZones = [];
    }

    if (!this.entities) {
      return;
    }

    const computedStyles = getComputedStyle(this);
    const zoneColor = computedStyles.getPropertyValue("--accent-color");
    const passiveZoneColor = computedStyles.getPropertyValue(
      "--secondary-text-color"
    );

    const darkPrimaryColor = computedStyles.getPropertyValue(
      "--dark-primary-color"
    );

    const className = this._darkMode ? "dark" : "light";

    for (const entity of this.entities) {
      const stateObj = hass.states[getEntityId(entity)];
      if (!stateObj) {
        continue;
      }
      const customTitle = typeof entity !== "string" ? entity.name : undefined;
      const title = customTitle ?? computeStateName(stateObj);
      const {
        latitude,
        longitude,
        passive,
        icon,
        radius,
        entity_picture: entityPicture,
        gps_accuracy: gpsAccuracy,
      } = stateObj.attributes;

      if (!(latitude && longitude)) {
        continue;
      }

      if (computeStateDomain(stateObj) === "zone") {
        // DRAW ZONE
        if (passive && !this.renderPassive) {
          continue;
        }

        // create icon
        let iconHTML = "";
        if (icon) {
          const el = document.createElement("ha-icon");
          el.setAttribute("icon", icon);
          iconHTML = el.outerHTML;
        } else {
          const el = document.createElement("span");
          el.innerHTML = title;
          iconHTML = el.outerHTML;
        }

        // create marker with the icon
        this._mapZones.push(
          Leaflet.marker([latitude, longitude], {
            icon: Leaflet.divIcon({
              html: iconHTML,
              iconSize: [24, 24],
              className,
            }),
            interactive: this.interactiveZones,
            title,
          })
        );

        // create circle around it
        this._mapZones.push(
          Leaflet.circle([latitude, longitude], {
            interactive: false,
            color: passive ? passiveZoneColor : zoneColor,
            radius,
          })
        );

        continue;
      }

      // DRAW ENTITY
      // create icon
      const entityName =
        typeof entity !== "string" && entity.label_mode === "state"
          ? this.hass.formatEntityState(stateObj)
          : (customTitle ??
            title
              .split(" ")
              .map((part) => part[0])
              .join("")
              .substr(0, 3));

      // create marker with the icon
      const marker = Leaflet.marker([latitude, longitude], {
        icon: Leaflet.divIcon({
          html: `
              <ha-entity-marker
                entity-id="${getEntityId(entity)}"
                entity-name="${entityName}"
                entity-picture="${
                  entityPicture ? this.hass.hassUrl(entityPicture) : ""
                }"
                ${
                  typeof entity !== "string"
                    ? `entity-color="${entity.color}"`
                    : ""
                }
              ></ha-entity-marker>
            `,
          iconSize: [48, 48],
          className: "",
        }),
        title: title,
      });
      this._mapItems.push(marker);
      if (typeof entity === "string" || entity.focus !== false) {
        this._mapFocusItems.push(marker);
      }

      // create circle around if entity has accuracy
      if (gpsAccuracy) {
        this._mapItems.push(
          Leaflet.circle([latitude, longitude], {
            interactive: false,
            color: darkPrimaryColor,
            radius: gpsAccuracy,
          })
        );
      }
    }

    this._mapItems.forEach((marker) => map.addLayer(marker));
    this._mapZones.forEach((marker) => map.addLayer(marker));
  }

  private async _attachObserver(): Promise<void> {
    if (!this._resizeObserver) {
      this._resizeObserver = new ResizeObserver(() => {
        this.leafletMap?.invalidateSize({ debounceMoveend: true });
      });
    }
    this._resizeObserver.observe(this);
  }

  static get styles(): CSSResultGroup {
    return css`
      :host {
        display: block;
        height: 300px;
      }
      #map {
        height: 100%;
      }
      #map.dark {
        background: #090909;
      }
      #map.forced-dark {
        color: #ffffff;
        --map-filter: invert(0.9) hue-rotate(170deg) brightness(1.5)
          contrast(1.2) saturate(0.3);
      }
      #map.forced-light {
        background: #ffffff;
        color: #000000;
        --map-filter: invert(0);
      }
      #map:active {
        cursor: grabbing;
        cursor: -moz-grabbing;
        cursor: -webkit-grabbing;
      }
      .leaflet-tile-pane {
        filter: var(--map-filter);
      }
      .dark .leaflet-bar a {
        background-color: #1c1c1c;
        color: #ffffff;
      }
      .dark .leaflet-bar a:hover {
        background-color: #313131;
      }
      .leaflet-marker-draggable {
        cursor: move !important;
      }
      .leaflet-edit-resize {
        border-radius: 50%;
        cursor: nesw-resize !important;
      }
      .named-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        flex-direction: column;
        text-align: center;
        color: var(--primary-text-color);
      }
      .leaflet-pane {
        z-index: 0 !important;
      }
      .leaflet-control,
      .leaflet-top,
      .leaflet-bottom {
        z-index: 1 !important;
      }
      .leaflet-tooltip {
        padding: 8px;
        font-size: 90%;
        background: rgba(80, 80, 80, 0.9) !important;
        color: white !important;
        border-radius: 4px;
        box-shadow: none !important;
        text-align: center;
      }
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-map": HaMap;
  }
}
