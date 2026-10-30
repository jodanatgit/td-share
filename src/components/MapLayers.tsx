import { useEffect } from 'react';
import { LayerGroup, LayersControl, TileLayer, useMap } from 'react-leaflet';

// Background maps for the event map. All are free to use with attribution and without an API key.

const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const ESRI_ATTR = 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

const STORAGE_KEY = 'td-share:baselayer';

export const BASE_LAYERS = ['Karta', 'Satellit', 'Satellit med namn', 'Terräng', 'Ljus'] as const;
type BaseLayerName = (typeof BASE_LAYERS)[number];

const savedBaseLayer = (): BaseLayerName => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return (BASE_LAYERS as readonly string[]).includes(v ?? '') ? (v as BaseLayerName) : 'Karta';
  } catch {
    return 'Karta';
  }
};

// Remembers the chosen background map on this device
function RememberBaseLayer() {
  const map = useMap();
  useEffect(() => {
    const onChange = (e: { name: string }) => {
      try {
        localStorage.setItem(STORAGE_KEY, e.name);
      } catch {
        // private mode
      }
    };
    map.on('baselayerchange', onChange);
    return () => {
      map.off('baselayerchange', onChange);
    };
  }, [map]);
  return null;
}

const imagery = (
  <TileLayer
    url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
    attribution={ESRI_ATTR}
    maxNativeZoom={18}
    maxZoom={20}
  />
);

// The layer switcher (top right): background maps, plus the overlays passed as children
const MapLayers = ({ children }: { children?: React.ReactNode }) => {
  const initial = savedBaseLayer();
  return (
    <>
      <RememberBaseLayer />
      <LayersControl position="topright">
        <LayersControl.BaseLayer name="Karta" checked={initial === 'Karta'}>
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution={OSM_ATTR} maxNativeZoom={19} maxZoom={20} />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Satellit" checked={initial === 'Satellit'}>
          {imagery}
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Satellit med namn" checked={initial === 'Satellit med namn'}>
          <LayerGroup>
            {imagery}
            <TileLayer
              url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
              attribution={ESRI_ATTR}
              maxNativeZoom={18}
              maxZoom={20}
            />
          </LayerGroup>
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Terräng" checked={initial === 'Terräng'}>
          <TileLayer
            url="https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png"
            attribution={`${OSM_ATTR}, SRTM | Style &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)`}
            maxNativeZoom={17}
            maxZoom={20}
          />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Ljus" checked={initial === 'Ljus'}>
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
            attribution={`${OSM_ATTR} &copy; <a href="https://carto.com/attributions">CARTO</a>`}
            maxNativeZoom={20}
            maxZoom={20}
          />
        </LayersControl.BaseLayer>
        {children}
      </LayersControl>
    </>
  );
};

export default MapLayers;
