/*global define*/
define([
        '../Core/AttributeCompression',
        '../Core/BoundingSphere',
        '../Core/Cartesian3',
        '../Core/Cartographic',
        '../Core/Color',
        '../Core/ComponentDatatype',
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/destroyObject',
        '../Core/DeveloperError',
        '../Core/DistanceDisplayCondition',
        '../Core/Ellipsoid',
        '../Core/getMagic',
        '../Core/getStringFromTypedArray',
        '../Core/loadArrayBuffer',
        '../Core/Math',
        '../Core/Matrix4',
        '../Core/NearFarScalar',
        '../Core/Request',
        '../Core/RequestScheduler',
        '../Core/RequestType',
        '../Core/TranslationRotationScale',
        '../ThirdParty/when',
        './BillboardCollection',
        './Cesium3DTileBatchTable',
        './Cesium3DTileContentState',
        './Cesium3DTileFeature',
        './GroundPolylineBatch',
        './GroundPrimitiveBatch',
        './LabelCollection',
        './LabelStyle',
        './PolylineCollection',
        './VerticalOrigin'
    ], function(
        AttributeCompression,
        BoundingSphere,
        Cartesian3,
        Cartographic,
        Color,
        ComponentDatatype,
        defaultValue,
        defined,
        defineProperties,
        destroyObject,
        DeveloperError,
        DistanceDisplayCondition,
        Ellipsoid,
        getMagic,
        getStringFromTypedArray,
        loadArrayBuffer,
        CesiumMath,
        Matrix4,
        NearFarScalar,
        Request,
        RequestScheduler,
        RequestType,
        TranslationRotationScale,
        when,
        BillboardCollection,
        Cesium3DTileBatchTable,
        Cesium3DTileContentState,
        Cesium3DTileFeature,
        GroundPolylineBatch,
        GroundPrimitiveBatch,
        LabelCollection,
        LabelStyle,
        PolylineCollection,
        VerticalOrigin) {
    'use strict';

    /**
     * @alias Vector3DTileContent
     * @constructor
     *
     * @private
     */
    function Vector3DTileContent(tileset, tile, url, arrayBuffer, byteOffset) {
        this._tileset = tileset;
        this._tile = tile;
        this._url = url;

        this._polygons = undefined;
        this._polylines = undefined;
        this._billboardCollection = undefined;
        this._labelCollection = undefined;
        this._polylineCollection = undefined;

        this._readyPromise = when.defer();

        this._batchTable = undefined;
        this._features = undefined;

        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        this.featurePropertiesDirty = false;

        initialize(this, arrayBuffer, byteOffset);
    }

    defineProperties(Vector3DTileContent.prototype, {
        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        featuresLength : {
            get : function() {
                return defined(this._batchTable) ? this._batchTable.featuresLength : 0;
            }
        },

        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        pointsLength : {
            get : function() {
                return 0;
            }
        },

        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        trianglesLength : {
            get : function() {
                return 0;
            }
        },

        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        geometryByteLength : {
            get : function() {
                return 0;
            }
        },

        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        texturesByteLength : {
            get : function() {
                return 0;
            }
        },

        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        batchTableByteLength : {
            get : function() {
                return defined(this._batchTable) ? this._batchTable.memorySizeInBytes : 0;
            }
        },

        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        innerContents : {
            get : function() {
                return undefined;
            }
        },

        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        readyPromise : {
            get : function() {
                return this._readyPromise.promise;
            }
        },

        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        tileset : {
            get : function() {
                return this._tileset;
            }
        },

        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        tile : {
            get : function() {
                return this._tile;
            }
        },

        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        url : {
            get : function() {
                return this._url;
            }
        },

        /**
         * Part of the {@link Cesium3DTileContent} interface.
         */
        batchTable : {
            get : function() {
                return this._batchTable;
            }
        }
    });

    function createColorChangedCallback(content, numberOfPolygons) {
        return function(batchId, color) {
            if (defined(content._polygons) && batchId < numberOfPolygons) {
                content._polygons.updateCommands(batchId, color);
            }
        };
    }

    var sizeOfUint16 = Uint16Array.BYTES_PER_ELEMENT;
    var sizeOfUint32 = Uint32Array.BYTES_PER_ELEMENT;

    var maxShort = 32767;

    var scratchCartographic = new Cartographic();
    var scratchCartesian3 = new Cartesian3();

    function initialize(content, arrayBuffer, byteOffset) {
        byteOffset = defaultValue(byteOffset, 0);

        var uint8Array = new Uint8Array(arrayBuffer);
        var magic = getMagic(uint8Array, byteOffset);
        if (magic !== 'vctr') {
            throw new DeveloperError('Invalid Vector tile.  Expected magic=vctr.  Read magic=' + magic);
        }

        var view = new DataView(arrayBuffer);
        byteOffset += sizeOfUint32;  // Skip magic number

        //>>includeStart('debug', pragmas.debug);
        var version = view.getUint32(byteOffset, true);
        if (version !== 1) {
            throw new DeveloperError('Only Vector tile version 1 is supported.  Version ' + version + ' is not.');
        }
        //>>includeEnd('debug');
        byteOffset += sizeOfUint32;

        var byteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;

        if (byteLength === 0) {
            content._readyPromise.resolve(content);
            return;
        }

        var featureTableJSONByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;

        //>>includeStart('debug', pragmas.debug);
        if (featureTableJSONByteLength === 0) {
            throw new DeveloperError('Feature table must have a byte length greater than zero');
        }
        //>>includeEnd('debug');

        var featureTableBinaryByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;
        var batchTableJSONByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;
        var batchTableBinaryByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;
        var indicesByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;
        var positionByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;
        var polylinePositionByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;
        var pointsPositionByteLength = view.getUint32(byteOffset, true);
        byteOffset += sizeOfUint32;

        var featureTableString = getStringFromTypedArray(uint8Array, byteOffset, featureTableJSONByteLength);
        var featureTableJson = JSON.parse(featureTableString);
        byteOffset += featureTableJSONByteLength;

        var featureTableBinary = new Uint8Array(arrayBuffer, byteOffset, featureTableBinaryByteLength);
        byteOffset += featureTableBinaryByteLength;

        var batchTableJson;
        var batchTableBinary;
        if (batchTableJSONByteLength > 0) {
            // PERFORMANCE_IDEA: is it possible to allocate this on-demand?  Perhaps keep the
            // arraybuffer/string compressed in memory and then decompress it when it is first accessed.
            //
            // We could also make another request for it, but that would make the property set/get
            // API async, and would double the number of numbers in some cases.
            var batchTableString = getStringFromTypedArray(uint8Array, byteOffset, batchTableJSONByteLength);
            batchTableJson = JSON.parse(batchTableString);
            byteOffset += batchTableJSONByteLength;

            if (batchTableBinaryByteLength > 0) {
                // Has a batch table binary
                batchTableBinary = new Uint8Array(arrayBuffer, byteOffset, batchTableBinaryByteLength);
                // Copy the batchTableBinary section and let the underlying ArrayBuffer be freed
                batchTableBinary = new Uint8Array(batchTableBinary);
                byteOffset += batchTableBinaryByteLength;
            }
        }

        var numberOfPolygons = defaultValue(featureTableJson.POLYGONS_LENGTH, 0);
        var numberOfPolylines = defaultValue(featureTableJson.POLYLINES_LENGTH, 0);
        var numberOfPoints = defaultValue(featureTableJson.POINTS_LENGTH, 0);

        var totalPrimitives = numberOfPolygons + numberOfPolylines + numberOfPoints;
        var batchTable = new Cesium3DTileBatchTable(content, totalPrimitives, batchTableJson, batchTableBinary, createColorChangedCallback(content, numberOfPolygons));
        content._batchTable = batchTable;

        if (totalPrimitives === 0) {
            return;
        }

        var center = Cartesian3.unpack(featureTableJson.RTC_CENTER);
        var minHeight = featureTableJson.MINIMUM_HEIGHT;
        var maxHeight = featureTableJson.MAXIMUM_HEIGHT;

        var i;
        var batchId;
        var batchIds;

        // TODO: must have rectangle
        var rectangle = content._tile.contentBoundingVolume.rectangle;

        if (numberOfPolygons > 0) {
            var indices = new Uint32Array(arrayBuffer, byteOffset, indicesByteLength / sizeOfUint32);
            byteOffset += indicesByteLength;

            var polygonPositions = new Uint16Array(arrayBuffer, byteOffset, positionByteLength / sizeOfUint16);
            byteOffset += positionByteLength;

            var polygonCountByteOffset = featureTableBinary.byteOffset + featureTableJson.POLYGON_COUNT.byteOffset;
            var counts = new Uint32Array(featureTableBinary.buffer, polygonCountByteOffset, numberOfPolygons);

            var polygonIndexCountByteOffset = featureTableBinary.byteOffset + featureTableJson.POLYGON_INDEX_COUNT.byteOffset;
            var indexCounts = new Uint32Array(featureTableBinary.buffer, polygonIndexCountByteOffset, numberOfPolygons);

            batchIds = new Array(numberOfPolygons);
            for (i = 0; i < numberOfPolygons; ++i) {
                batchId = i + numberOfPoints;
                batchIds[i] = batchId;
            }

            content._polygons = new GroundPrimitiveBatch({
                positions : polygonPositions,
                counts : counts,
                indexCounts : indexCounts,
                indices : indices,
                minimumHeight : minHeight,
                maximumHeight : maxHeight,
                center : center,
                rectangle : rectangle,
                boundingVolume : content._tile._boundingVolume.boundingVolume,
                batchTable : batchTable,
                batchIds : batchIds
            });
        }

        if (numberOfPolylines > 0) {
            var polylinePositions = new Uint16Array(arrayBuffer, byteOffset, polylinePositionByteLength / sizeOfUint16);
            byteOffset += polylinePositionByteLength;

            var polylineCountByteOffset = featureTableBinary.byteOffset + featureTableJson.POLYLINE_COUNT.byteOffset;
            var polylineCounts = new Uint32Array(featureTableBinary.buffer, polylineCountByteOffset, numberOfPolylines);

            var widths = new Array(numberOfPolylines);
            batchIds = new Array(numberOfPolylines);
            var polygonBatchOffset = numberOfPoints + numberOfPolygons;
            for (i = 0; i < numberOfPolylines; ++i) {
                widths[i] = 2.0;
                batchIds[i] = i + polygonBatchOffset;
            }

            content._polylines = new GroundPolylineBatch({
                positions : polylinePositions,
                widths : widths,
                counts : polylineCounts,
                batchIds : batchIds,
                minimumHeight : minHeight,
                maximumHeight : maxHeight,
                center : center,
                rectangle : rectangle,
                boundingVolume : content._tile._boundingVolume.boundingVolume,
                batchTable : batchTable
            });
        }

        if (numberOfPoints > 0) {
            // TODO: ellipsoid
            var ellipsoid = Ellipsoid.WGS84;

            var pointPositions = new Uint16Array(arrayBuffer, byteOffset, pointsPositionByteLength / sizeOfUint16);

            content._billboardCollection = new BillboardCollection({ batchTable : batchTable });
            content._labelCollection = new LabelCollection({ batchTable : batchTable });
            content._polylineCollection = new PolylineCollection();

            var uBuffer = pointPositions.subarray(0, numberOfPoints);
            var vBuffer = pointPositions.subarray(numberOfPoints, 2 * numberOfPoints);
            var heightBuffer = pointPositions.subarray(2 * numberOfPoints, 3 * numberOfPoints);
            AttributeCompression.zigZagDeltaDecode(uBuffer, vBuffer, heightBuffer);

            for (i = 0; i < numberOfPoints; ++i) {
                var u = uBuffer[i];
                var v = vBuffer[i];
                var height = heightBuffer[i];

                var lon = CesiumMath.lerp(rectangle.west, rectangle.east, u / maxShort);
                var lat = CesiumMath.lerp(rectangle.south, rectangle.north, v / maxShort);
                var alt = CesiumMath.lerp(minHeight, maxHeight, height / maxShort);

                var cartographic = Cartographic.fromRadians(lon, lat, alt, scratchCartographic);
                var position = ellipsoid.cartographicToCartesian(cartographic, scratchCartesian3);

                var b = content._billboardCollection.add();
                b.position = position;
                b.verticalOrigin = VerticalOrigin.BOTTOM;
                b._batchIndex = i;

                var l = content._labelCollection.add();
                l.text = ' ';
                l.position = position;
                l.verticalOrigin = VerticalOrigin.BOTTOM;
                l._batchIndex = i;

                var p = content._polylineCollection.add();
                p.positions = [Cartesian3.clone(position), Cartesian3.clone(position)];
            }
        }
    }

    function createFeatures(content) {
        var tileset = content._tileset;
        var featuresLength = content.featuresLength;
        if (!defined(content._features) && (featuresLength > 0)) {
            var features = new Array(featuresLength);
            for (var i = 0; i < featuresLength; ++i) {
                if (defined(content._billboardCollection) && i < content._billboardCollection.length) {
                    var billboardCollection = content._billboardCollection;
                    var labelCollection = content._labelCollection;
                    var polylineCollection = content._polylineCollection;
                    features[i] = new Cesium3DTileFeature(tileset, content, i, billboardCollection, labelCollection, polylineCollection);
                } else {
                    features[i] = new Cesium3DTileFeature(tileset, content, i);
                }
            }
            content._features = features;
        }
    }

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Vector3DTileContent.prototype.hasProperty = function(batchId, name) {
        return this._batchTable.hasProperty(batchId, name);
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Vector3DTileContent.prototype.getFeature = function(batchId) {
        //>>includeStart('debug', pragmas.debug);
        var featuresLength = this.featuresLength;
        if (!defined(batchId) || (batchId < 0) || (batchId >= featuresLength)) {
            throw new DeveloperError('batchId is required and between zero and featuresLength - 1 (' + (featuresLength - 1) + ').');
        }
        //>>includeEnd('debug');

        createFeatures(this);
        return this._features[batchId];
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Vector3DTileContent.prototype.applyDebugSettings = function(enabled, color) {
        if (defined(this._polygons)) {
            this._polygons.applyDebugSettings(enabled, color);
        }
        if (defined(this._polylines)) {
            this._polylines.applyDebugSettings(enabled, color);
        }

        //TODO: debug settings for points/billboards/labels
    };

    function clearStyle(content) {
        var length = content._features.length;
        for (var i = 0; i < length; ++i) {
            var feature = content.getFeature(i);

            feature.show = true;
            feature.color = Color.WHITE;
            feature.pointSize = 8.0;
            feature.pointColor = Color.WHITE;
            feature.pointOutlineColor = Color.BLACK;
            feature.pointOutlineWidth = 0.0;
            feature.labelOutlineColor = Color.WHITE;
            feature.labelOutlineWidth = 1.0;
            feature.font = '30px sans-serif';
            feature.labelStyle = LabelStyle.FILL;
            feature.labelText = undefined;
            feature.backgroundColor = undefined;
            feature.backgroundPadding = undefined;
            feature.backgroundEnabled = false;
            feature.scaleByDistance = undefined;
            feature.translucencyByDistance = undefined;
            feature.distanceDisplayCondition = undefined;
            feature.heightOffset = 0.0;
            feature.anchorLineEnabled = false;
            feature.anchorLineColor = Color.WHITE;
            feature.image = undefined;

            feature._setBillboardImage();
        }
    }

    var scratchColor = new Color();
    var scratchColor2 = new Color();
    var scratchColor3 = new Color();
    var scratchColor4 = new Color();
    var scratchColor5 = new Color();
    var scratchColor6 = new Color();

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Vector3DTileContent.prototype.applyStyle = function(frameState, style) {
        createFeatures(this);

        if (!defined(style)) {
            clearStyle(this);
            return;
        }

        var length = this._features.length;
        for (var i = 0; i < length; ++i) {
            var feature = this.getFeature(i);
            feature.color = style.color.evaluateColor(frameState, feature, scratchColor);
            feature.show = style.show.evaluate(frameState, feature);
            feature.pointSize = style.pointSize.evaluate(frameState, feature);
            feature.pointColor = style.pointColor.evaluateColor(frameState, feature, scratchColor2);
            feature.pointOutlineColor = style.pointOutlineColor.evaluateColor(frameState, feature, scratchColor3);
            feature.pointOutlineWidth = style.pointOutlineWidth.evaluate(frameState, feature);
            feature.labelOutlineColor = style.labelOutlineColor.evaluateColor(frameState, feature, scratchColor4);
            feature.labelOutlineWidth = style.labelOutlineWidth.evaluate(frameState, feature);
            feature.font = style.font.evaluate(frameState, feature);
            feature.labelStyle = style.labelStyle.evaluate(frameState, feature);

            if (defined(style.labelText)) {
                feature.labelText = style.labelText.evaluate(frameState, feature);
            } else {
                feature.labelText = undefined;
            }

            if (defined(style.backgroundColor)) {
                feature.backgroundColor = style.backgroundColor.evaluateColor(frameState, feature, scratchColor5);
            }

            if (defined(style.backgroundPadding)) {
                feature.backgroundPadding = style.backgroundPadding.evaluate(frameState, feature);
            }

            feature.backgroundEnabled = style.backgroundEnabled.evaluate(frameState, feature);

            if (defined(style.scaleByDistance)) {
                var scaleByDistanceCart4 = style.scaleByDistance.evaluate(frameState, feature);
                feature.scaleByDistance = new NearFarScalar(scaleByDistanceCart4.x, scaleByDistanceCart4.y, scaleByDistanceCart4.z, scaleByDistanceCart4.w);
            } else {
                feature.scaleBydistance = undefined;
            }

            if (defined(style.translucencyByDistance)) {
                var translucencyByDistanceCart4 = style.translucencyByDistance.evaluate(frameState, feature);
                feature.translucencyByDistance = new NearFarScalar(translucencyByDistanceCart4.x, translucencyByDistanceCart4.y, translucencyByDistanceCart4.z, translucencyByDistanceCart4.w);
            } else {
                feature.translucencyByDistance = undefined;
            }

            if (defined(style.distanceDisplayCondition)) {
                var distanceDisplayConditionCart2 = style.distanceDisplayCondition.evaluate(frameState, feature);
                feature.distanceDisplatCondition = new DistanceDisplayCondition(distanceDisplayConditionCart2.x, distanceDisplayConditionCart2.y);
            } else {
                feature.distanceDisplayCondition = undefined;
            }

            feature.heightOffset = style.heightOffset.evaluate(frameState, feature);
            feature.anchorLineEnabled = style.anchorLineEnabled.evaluate(frameState, feature);
            feature.anchorLineColor = style.anchorLineColor.evaluateColor(frameState, feature, scratchColor6);

            if (defined(style.image)) {
                feature.image = style.image.evaluate(frameState, feature);
            } else {
                feature.image = undefined;
            }

            feature._setBillboardImage();
        }
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Vector3DTileContent.prototype.update = function(tileset, frameState) {
        if (defined(this._batchTable)) {
            this._batchTable.update(tileset, frameState);
        }

        if (defined(this._polygons)) {
            this._polygons.update(frameState);
        }

        if (defined(this._polylines)) {
            this._polylines.update(frameState);
        }

        if (defined(this._billboardCollection)) {
            this._billboardCollection.update(frameState);
            this._labelCollection.update(frameState);
            this._polylineCollection.update(frameState);
        }

        if (!defined(this._polygonReadyPromise)) {
            if (defined(this._polygons)) {
                var that = this;
                this._polygonReadyPromise = this._polygons.readyPromise.then(function() {
                    that._readyPromise.resolve(that);
                });
            } else {
                this._polygonReadyPromise = true;
                this._readyPromise.resolve(this);
            }
        }
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Vector3DTileContent.prototype.isDestroyed = function() {
        return false;
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    Vector3DTileContent.prototype.destroy = function() {
        this._polygons = this._polygons && this._polygons.destroy();
        this._polylines = this._polylines && this._polylines.destroy();
        this._billboardCollection = this._billboardCollection && this._billboardCollection.destroy();
        this._labelCollection = this._labelCollection && this._labelCollection.destroy();
        this._polylineCollection = this._polylineCollection && this._polylineCollection.destroy();
        this._batchTable = this._batchTable && this._batchTable.destroy();
        return destroyObject(this);
    };

    return Vector3DTileContent;
});