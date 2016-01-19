/**
 * @file
 * Search provider for the search node framework.
 */

angular.module('searchBoxApp').service('searchNodeProvider', ['CONFIG', '$q', '$http', 'CacheFactory',
  function (CONFIG, $q, $http, CacheFactory) {
    'use strict';

    // Configuration options.
    var configuration = CONFIG.provider;

    // Search node connection handling.
    var socket;
    var loadedSocketIo = false;
    var token = null;

    // Create cache object.
    var searchCache = new CacheFactory('searchCache' + CONFIG.id, {
      maxAge: configuration.cacheExpire * 1000,
      deleteOnExpire: 'aggressive',
      storageMode: 'localStorage'
    });

    // Holder for the latest search query filters.
    var currentFilters;

    /**
     * Find the size of given object.
     *
     * @TODO: Review - Size: as in number of properties? Maybe change naming?
     *
     * @return int
     *   The size of the object or 0 if empty.
     */
    function objectSize(obj) {
      var size = 0;
      for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
          size++;
        }
      }

      return size;
    }

    /**
     * Load the socket.io library provided by the search node.
     *
     * @return {promise}
     *   An promise is return that will be resolved on library loaded.
     */
    function loadSocketIoScript() {
      var deferred = $q.defer();

      // Check if it have been loaded.
      if (!loadedSocketIo) {
        // Create script element.
        var script = document.createElement("script");
        script.type = "text/javascript";

        // Add event handlers for the library loaded.
        if (script.readyState) {
          // Handle Internet Explore.
          script.onreadystatechange = function () {
            if (script.readyState === "loaded" || script.readyState === "complete") {
              script.onreadystatechange = null;
              loadedSocketIo = true;
              deferred.resolve();
            }
          };
        } else {
          // All other browsers.
          script.onload = function () {
            loadedSocketIo = true;
            deferred.resolve();
          };
        }

        // Add the script and add it to the dom to load it.
        script.src = configuration.host + "/socket.io/socket.io.js";
        document.getElementsByTagName("head")[0].appendChild(script);
      }
      else {
        deferred.resolve();
      }

      return deferred.promise;
    }

    /**
     * Connect to the web-socket.
     *
     * @param deferred
     *   The deferred object that should be resolved on connection.
     */
    function getSocket(deferred) {
      // Load the socket library.
      loadSocketIoScript().then(function () {
        // Get connected to the server.
        socket = io.connect(configuration.host, {
          'query': 'token=' + token,
          'force new connection': true,
          'max reconnection attempts': Infinity
        });

        // Handle error events.
        socket.on('error', function (reason) {
          console.error(reason, 'Search socket error.');
          deferred.reject(reason);
        });

        socket.on('connect', function () {
          deferred.resolve('Connected to the server.');
        });

        // Handle disconnect event (fires when disconnected or connection fails).
        socket.on('disconnect', function (reason) {
          // @todo: re-connection is automatically handled by socket.io library,
          // but we might need to stop sending request until reconnection or the
          // request will be queued and sent all at once... which could give
          // some strange side effects in the application if not handled.
        });
      });
    }

    /**
     * Create the connection to the server.
     *
     * @return {promise}
     *   A promise is return that will be resolved on connection.
     */
    function connect() {
      // Try to connect to the server if not already connected.
      var deferred = $q.defer();

      if (socket === undefined) {
        if (token !== null) {
          getSocket(deferred);
        }
        else {
          $http.get(configuration.auth)
            .success(function (data) {
              token = data.token;
              getSocket(deferred);
            })
            .error(function (data, status) {
              console.error(data, 'Authentication (search) to search node failed (' + status + ')');
              deferred.reject(status);
            });
        }
      }
      else {
        deferred.resolve('Connected to the server.');
      }

      return deferred.promise;
    }

    /**
     * Builds aggregation query based on filters.
     *
     * @param filters
     */
    function buildAggregationQuery(filters) {
      // Basic aggregation query.
      var query = {
        "aggs": {}
      };

      // Extend query with filter fields.
      for (var i = 0; i < filters.length; i++) {
        var filter = filters[i];
        query.aggs[filter.name] = {
          "terms": {
            "field": filter.field + '.raw',
            "size": 0
          }
        };
      }

      return query;
    }

    /**
     * Parse filter configuration and search aggregations.
     *
     * Merge result with filters configuration as not all terms may have
     * been used in the content and then not in found in the search
     * node.
     *
     * @param aggs
     *
     * @returns {{}}
     */
    function parseFilters(aggs) {
      var results = {};
      if (CONFIG.provider.hasOwnProperty('filters')) {
        var filters = CONFIG.provider.filters;

        for (var i = 0; i < filters.length; i++) {
          var filter = angular.copy(filters[i]);

          // Set basic filter with counts.
          results[filter.field] = {
            'name': filter.name,
            'items': filter.terms
          };

          // Run through counts and update the filter.
          if (objectSize(aggs) !== 0) {
            for (var j = 0; j < aggs[filter.name].buckets.length; j++) {
              var bucket = aggs[filter.name].buckets[j];
              if (results[filter.field].items.hasOwnProperty(bucket.key)) {
                results[filter.field].items[bucket.key].count = Number(bucket.doc_count);
              }
              else {
                console.error('Filter value don\'t match configuration: ' + filter.field + ' -> ' + bucket.key);
              }
            }
          }
        }
      }

      return results;
    }
    /**
     * Get the list of available filters not parsed with search results.
     *
     * @return object
     *  The filters from the configuration.
     */
    this.getRawFilters = function getRawFilters() {
      var result = {};

      if (CONFIG.provider.hasOwnProperty('filters')) {
        var filters = CONFIG.provider.filters;
        for (var i = 0; i < filters.length; i++) {

          // Set basic filter with counts.
          result[filters[i].field] = {
            'name': filters[i].name,
            'items': filters[i].terms
          };
        }
      }

      return result;
    };

    /**
     * Get the list of available filters.
     *
     * @PLAN:
     *   Check if latest search returned aggregations, if not use the
     *   configuration to search the get all available aggregations.
     *
     *   Merge it with configuration to ensure that all possible filters are
     *   displayed with count.
     */
    this.getFilters = function getFilters() {
      var deferred = $q.defer();

      // Get filters from configuration.
      if (CONFIG.provider.hasOwnProperty('filters')) {
        var filters = CONFIG.provider.filters;

        // If no search has been executed yet, load the default filters across
        // all indexed data.
        if (currentFilters === undefined) {
          // Check if filters are cached.
          var cachedFilters = searchCache.get('filters');

          if (cachedFilters !== undefined) {
            // Store current filters.
            currentFilters = cachedFilters;

            // Return the result.
            deferred.resolve(angular.copy(currentFilters));
          }
          else {
            // Get the query.
            var query = buildAggregationQuery(filters);

            /**
             * @TODO: Added forced fields and other search options.
             */

            // Send the request to search node.
            connect().then(function () {
              socket.emit('count', query);
              socket.once('counts', function (counts) {
                var results = parseFilters(counts);

                // Store initial filters in cache.
                searchCache.put('filters', results);

                // Store current filters.
                currentFilters = results;

                // Return the result.
                deferred.resolve(results);
              });

              // Catch search errors.
              socket.once('searchError', function (error) {
                console.error('Search error', error.message);
                deferred.reject(error.message);
              });
            });
          }
        }
        else {
          // Return the result.
          deferred.resolve(angular.copy(currentFilters));
        }
      }
      else {
        deferred.resolve({});
      }

      return deferred.promise;
    };

    /**
     * Execute search query.
     *
     * @param searchQuery
     * @returns {*}
     */
    this.search = function search(searchQuery) {
      var deferred = $q.defer();

      // Build default "match all" search query.
      var query = {
        "index": configuration.index,
        "query": {
          "filtered": {
            "query": {
              "match_all": {}
            }
          }
        }
      };

      // Text given build field search query.
      // The analyser ensures that we match the who text string sent not part
      // of.
      if (searchQuery.text !== undefined && searchQuery.text !== '') {
        var fields = configuration.fields;
        // Check if boost exist for the fields.
        if (configuration.hasOwnProperty('boost') && objectSize(configuration.boost)) {
          // Add boost to fields.
          for (var i in fields) {
            if (configuration.boost.hasOwnProperty(fields[i])) {
              fields[i] = fields[i] + '^' + configuration.boost[fields[i]];
            }
          }
        }

        query.query.filtered.query = {
          "multi_match": {
            "query": searchQuery.text,
            "fields": fields,
            "analyzer": 'string_search'
          }
        };
      }

      // Add filter.
      if (searchQuery.hasOwnProperty('filters')) {
        var filters = angular.copy(searchQuery.filters);

        // Build query filter.
        var queryFilter = {
          "bool": {
            "must": []
          }
        };

        // Load over all filters.
        for (var field in filters) {
          /**
           * @TODO: Needs to get information from configuration about execution
           *        type?
           */
          var terms = {
            "execution": "and"
          };

          terms[field + '.raw'] = [];
          for (var term in filters[field]) {
            // Check the the term is "true", hence is selected.
            if (filters[field][term]) {
              terms[field + '.raw'].push(term);
            }
          }

          if (terms[field + '.raw'].length) {
            queryFilter.bool.must.push({ "terms": terms });
          }
        }

        // Add the query filter if filled out.
        if (queryFilter.bool.must.length) {
          query.query.filtered.filter = queryFilter;
        }
      }

      // Add pager to the query.
      if (searchQuery.hasOwnProperty('pager')) {
        query.size = searchQuery.pager.size;
        query.from = searchQuery.pager.page * searchQuery.pager.size;
      }

      // Check if aggregations/filters counts should be used.
      if (CONFIG.provider.hasOwnProperty('filters')) {
        // Get the query.
        var aggs = buildAggregationQuery(CONFIG.provider.filters);
        angular.extend(query, aggs);
      }

      // Add range/interval search to the query.
      if (searchQuery.hasOwnProperty('intervals')) {
        // Check if any filters have been defined.
        if (!query.query.filtered.hasOwnProperty('filter')) {
          query.query.filtered.filter = {
            "bool": {
              "must": []
            }
          };
        }

        // Loop over the intervals and build range terms.
        for (var field in searchQuery.intervals) {
          var interval = {
            "range": {}
          };
          interval.range[field] = {
            "gte": searchQuery.intervals[field].from,
            "lte": searchQuery.intervals[field].to
          };
          query.query.filtered.filter.bool.must.push(interval);
        }
      }

      // Add date interval search.
      if (searchQuery.hasOwnProperty('dates')) {
        // Check if any filters have been defined.
        if (!query.query.filtered.hasOwnProperty('filter')) {
          query.query.filtered.filter = {
            "bool": {
              "should": [ ]
            }
          };
        }
        else {
          query.query.filtered.filter.bool.should = [];
        }

        // Loop over the intervals and build range terms.
        for (var field in searchQuery.dates) {
          var config = configuration.dates[field];
          var template = {
            "bool": {
              "must": [
                {
                  "range": {}
                },
                {
                  "range": {}
                }
              ]
            }
          };

          // Overlap start of the interval.
          template.bool.must[0].range[config.from] = {
            "lte": searchQuery.dates[field].from
          };
          template.bool.must[1].range[config.to] = {
            "gt": searchQuery.dates[field].from
          };
          query.query.filtered.filter.bool.should.push(angular.copy(template));

          // Overlap end of the interval.
          template.bool.must[0].range[config.from] = {
            "lt": searchQuery.dates[field].to
          };
          template.bool.must[1].range[config.to] = {
            "gte": searchQuery.dates[field].to
          };
          query.query.filtered.filter.bool.should.push(angular.copy(template));

          // Overlap both endes of the interval.
          template.bool.must[0].range[config.from] = {
            "gte": searchQuery.dates[field].from
          };
          template.bool.must[1].range[config.to] = {
            "lte": searchQuery.dates[field].to
          };
          query.query.filtered.filter.bool.should.push(angular.copy(template));
        }
      }

      // Create cache key based on the finale search query.
      var cid = CryptoJS.MD5(JSON.stringify(query)).toString();

      // Check cache for hits.
      var hits = searchCache.get(cid);
      if (hits !== undefined) {
        // Update filters cache.
        if (hits.hasOwnProperty('aggs')) {
          currentFilters = parseFilters(angular.copy(hits.aggs));
        }

        deferred.resolve(hits);
      }
      else {
        connect().then(function () {
          socket.emit('search', query);
          socket.once('result', function (hits) {
            // Update cache filters cache, based on the current search result.
            if (hits.hasOwnProperty('aggs')) {
              // Store current filters.
              currentFilters = parseFilters(angular.copy(hits.aggs));
            }

            // Save hits in cache.
            searchCache.put(cid, hits);

            deferred.resolve(hits);
          });

          // Catch search errors.
          socket.once('searchError', function (error) {
            console.error('Search error', error.message);
            deferred.reject(error.message);
          });
        });
      }

      return deferred.promise;
    };
  }
]);