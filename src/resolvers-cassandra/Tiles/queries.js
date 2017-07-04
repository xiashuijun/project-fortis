'use strict';

const Promise = require('promise');
const cassandraConnector = require('../../clients/cassandra/CassandraConnector');
const featureServiceClient = require('../../clients/locations/FeatureServiceClient');
const withRunTime = require('../shared').withRunTime;

/**
 * @see http://wiki.openstreetmap.org/wiki/Slippy_map_tilenames#Python
 */
function deg2num(lat_deg, lon_deg, zoom) {
  const lat_rad = lat_deg * Math.PI / 180;
  const n = Math.pow(2, zoom);
  const xtile = Math.floor((lon_deg + 180) / 360 * n);
  const ytile = Math.floor((1 - Math.log(Math.tan(lat_rad) + (1 / Math.cos(lat_rad))) / Math.PI) / 2 * n);
  return {tilex: xtile, tiley: ytile, tilez: zoom};
}

function makeMap(iterable, keyFunc, valueFunc) {
  const map = {};
  iterable.forEach(item => {
    const key = keyFunc(item);
    const value = valueFunc(item);
    map[key] = value;
  });
  return map;
}

function makeComputedTilesForTilesQuery(args, tiles) {
  let params = [];
  let clauses = [];

  tiles.forEach(tile => {
    clauses.push('(tilex = ? AND tiley = ? AND tilez = ?)');
    params.push(tile.tilex);
    params.push(tile.tiley);
    params.push(tile.tilez);
  });

  const keywords = (args.filteredEdges || []).concat(args.mainEdge ? [args.mainEdge] : []);
  if (keywords.length) {
    clauses.push(`(${keywords.map(_ => '(keyword = ?)').join(' OR ')})`); // eslint-disable-line no-unused-vars
    params = params.concat(keywords);
  }

  if (args.sourceFilter && args.sourceFilter.length) {
    clauses.push(`(${args.sourceFilter.map(_ => '(pipeline = ?)').join(' OR ')})`); // eslint-disable-line no-unused-vars
    params = params.concat(args.sourceFilter);
  }

  if (args.fromDate) {
    clauses.push('(periodstartdate >= ?)');
    params.push(args.fromDate);
  }

  if (args.toDate) {
    clauses.push('(periodenddate <= ?)');
    params.push(args.toDate);
  }

  if (args.timespan) {
    clauses.push('(periodtype = ?)');
    params.push(args.timespan);
  }

  const query = `SELECT tileid, computedfeatures FROM computedtiles WHERE ${clauses.join(' AND ')}`;
  return {query: query, params: params};
}

/**
 * @param {{site: string, bbox: number[], mainEdge: string, filteredEdges: string[], timespan: string, zoomLevel: number, layertype: string, sourceFilter: string[], fromDate: string, toDate: string}} args
 * @returns {Promise.<{runTime: string, type: string, bbox: number[], features: Array<{type: string, coordinates: number[], properties: {mentionCount: number, location: string, population: number, neg_sentiment: number, pos_sentiment: number, tileId: string}}>}>}
 */
function fetchTilesByBBox(args, res) { // eslint-disable-line no-unused-vars
  return new Promise((resolve, reject) => {
    if (!args || !args.bbox) return reject('No bounding box for which to fetch tiles specified');
    if (!args || !args.zoomLevel) return reject('No zoom level for which to fetch tiles specified');
    if (args.bbox.length !== 4) return reject('Invalid bounding box for which to fetch tiles specified');

    const fence = {north: args.bbox[0], west: args.bbox[1], south: args.bbox[2], east: args.bbox[3]};
    const bboxCornerPoints = [{latitude: fence.north, longitude: fence.west}, {latitude: fence.south, longitude: fence.west}, {latitude: fence.north, longitude: fence.east}, {latitude: fence.south, longitude: fence.east}];
    const tilesInBbox = bboxCornerPoints.map(point => deg2num(point.latitude, point.longitude, args.zoomLevel));
    const query = makeComputedTilesForTilesQuery(args, tilesInBbox);

    cassandraConnector.executeQuery(query.query, query.params)
    .then(rows => {
      const rowsByTileId = makeMap(rows, row => row.tileid, row => row);
      const features = Object.keys(rowsByTileId).map(tileId => {
        const row = rowsByTileId[tileId];
        return {
          properties: {
            pos_sentiment: row.computedfeatures && row.computedfeatures.sentiment && row.computedfeatures.sentiment.pos_avg,
            neg_sentiment: row.computedfeatures && row.computedfeatures.sentiment && row.computedfeatures.sentiment.neg_avg,
            mentionCount: row.computedfeatures && row.computedfeatures.mentions,
            tileId: tileId
          }
        };
      });

      resolve({
        features: features
      });
    })
    .catch(reject);
  });
}

/**
 * @param {{site: string, locations: number[][], filteredEdges: string[], timespan: string, layertype: string, sourceFilter: string, fromDate: string, toDate: string}} args
 * @returns {Promise.<{runTime: string, type: string, bbox: number[], features: Array<{type: string, coordinates: number[], properties: {mentionCount: number, location: string, population: number, neg_sentiment: number, pos_sentiment: number, tileId: string}}>}>}
 */
function fetchTilesByLocations(args, res) { // eslint-disable-line no-unused-vars
}

/**
 * @param {{site: string, bbox: number[], zoom: number, populationMin: number, populationMax: number}} args
 * @returns {Promise.<{runTime: string, type: string, bbox: number[], features: Array<{coordinate: number[], name: string, id: string, population: number, kind: string, tileId: string, source: string>}>}
 */
function fetchPlacesByBBox(args, res) { // eslint-disable-line no-unused-vars
  return new Promise((resolve, reject) => {
    if (!args || !args.bbox) return reject('No bounding box for which to fetch places specified');
    if (args.bbox.length !== 4) return reject('Invalid bounding box for which to fetch places specified');

    featureServiceClient.fetchByBbox({north: args.bbox[0], west: args.bbox[1], south: args.bbox[2], east: args.bbox[3]})
    .then(places => {
      const features = places.map(place => ({coordinate: place.bbox, name: place.name, id: place.id}));
      resolve({
        features: features,
        bbox: args.bbox
      });
    })
    .catch(reject);
  });
}

/**
 * @param {{site: string, locations: number[][], timespan: string, layertype: string, sourceFilter: string[], fromDate: string, toDate: string}} args
 * @returns {Promise.<{runTime: string, edges: Array<{type: string, name: string, mentionCount: string}>}>}
 */
function fetchEdgesByLocations(args, res) { // eslint-disable-line no-unused-vars
}

/**
 * @param {{site: string, bbox: number[], zoomLevel: number, mainEdge: string, timespan: string, layertype: string, sourceFilter: string[], fromDate: string, toDate: string}} args
 * @returns {Promise.<{runTime: string, edges: Array<{type: string, name: string, mentionCount: string}>}>}
 */
function fetchEdgesByBBox(args, res) { // eslint-disable-line no-unused-vars
}

module.exports = {
  fetchTilesByBBox: withRunTime(fetchTilesByBBox),
  fetchTilesByLocations: withRunTime(fetchTilesByLocations),
  fetchPlacesByBBox: withRunTime(fetchPlacesByBBox),
  fetchEdgesByLocations: withRunTime(fetchEdgesByLocations),
  fetchEdgesByBBox: withRunTime(fetchEdgesByBBox)
};
