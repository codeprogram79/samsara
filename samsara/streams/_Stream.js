/* Copyright © 2015-2016 David Valdman */

define(function(require, exports, module){
    var tick = require('../core/tick');
    var EventHandler = require('../events/EventHandler');
    var EventFilter = require('../events/EventFilter');
    var StreamContract = require('../streams/_StreamContract');

    var EVENTS = {
        START : 'start',
        UPDATE : 'update',
        END : 'end',
        SET : 'set',
        LOCK : 'lockBelow',
        UNLOCK : 'unlockBelow'
    };

    /**
     * Stream listens to `start`, `update` and `end` events and
     *  emits `start`, `update` and `end` events.
     *
     *  If listening to multiple sources, Stream emits a single event per
     *  Engine cycle.
     *
     *  @example
     *
     *      var position = new Transitionable([0,0]);
     *      var size = new EventEmitter();
     *
     *      var translationStream = Stream.lift(function(position, size){
     *          var translation = [
     *              position[0] + size[0],
     *              position[1] + size[1]
     *          ];
     *
     *          return Transform.translate(translation);
     *      }, [positionStream, sizeStream]);
     *
     *      translationStream.on('start', function(transform){
     *          console.log(transform);
     *      });
     *
     *      translationStream.on('update', function(transform){
     *          console.log(transform);
     *      });
     *
     *      translationStream.on('end', function(transform){
     *          console.log(transform);
     *      });
     *
     *      position.set([100, 50], {duration : 500});
     *
     * @class Stream
     * @extends Streams.SimpleStream
     * @namespace Streams
     * @param [options] {Object}            Options
     * @param [options.set] {Function}      Custom logic to map the `set` event
     * @param [options.start] {Function}    Custom logic to map the `start` event
     * @param [options.update] {Function}   Custom logic to map the `update` event
     * @param [options.end] {Function}      Custom logic to map the `end` event
     * @constructor
     */
    function Stream(triggers){
        StreamContract.call(this);

        this._triggers = triggers;
        this._numSources = 0;

        this._eventInput = new EventHandler();

        this.filter = new EventFilter(function(type, value){
            return !(
                type === EVENTS.SET    ||
                type === EVENTS.START  ||
                type === EVENTS.UPDATE ||
                type === EVENTS.END    ||
                type === EVENTS.LOCK   ||
                type === EVENTS.UNLOCK
            );
        });

        this.filter.subscribe(this._eventInput);
        this._eventOutput.subscribe(this.filter);

        // createResolveStrategy.call(this, this._triggers);
        createSimpleStrategy.call(this, this._triggers);
    }

    Stream.prototype = Object.create(StreamContract.prototype);
    Stream.prototype.constructor = Stream;

    function createSimpleStrategy(triggers){
        this._eventInput.off(['start', 'update', 'end', 'set', 'unlockBelow', 'lockBelow']);

        this._eventInput.on(EVENTS.SET, function(data){
            if (triggers && triggers.set) data = triggers.set(data);
            this.emit(EVENTS.SET, data);
        }.bind(this));

        this._eventInput.on(EVENTS.START, function(data){
            if (triggers && triggers.start) data = triggers.start(data);
            this.emit(EVENTS.START, data);
        }.bind(this));

        this._eventInput.on(EVENTS.UPDATE, function(data){
            if (triggers && triggers.update) data = triggers.update(data);
            this.emit(EVENTS.UPDATE, data);
        }.bind(this));

        this._eventInput.on(EVENTS.END, function(data){
            if (triggers && triggers.end) data = triggers.end(data);
            this.emit(EVENTS.END, data);
        }.bind(this));
    }

    function createResolveStrategy(triggers){
        this._eventInput.off(['start', 'update', 'end', 'set']);

        var hasTicked = false;
        var startCounter = 0;

        var hasSentLock = false;
        var hasReceived = false;
        var locked = false;
        var lockCounter = 0;
        var self = this;

        var states = {
            set: false,
            start : false,
            update : false,
            end : false,
            prev : ''
        };

        function resolve(data){
            if (hasSentLock){
                self.emit('unlockBelow');
                hasSentLock = false;
            }

            if (startCounter === 0 && states.update && states.end){
                // update and end called in the same tick when tick should end
                this.emit(EVENTS.UPDATE, data);
                states.prev = EVENTS.UPDATE;
                states.update = false;
            }
            else if (states.prev === EVENTS.START && states.set) {
                states.set = false;
            }
            else if (states.prev !== EVENTS.UPDATE && states.start && states.update){
                // start and update called in the same tick
                this.emit(EVENTS.START, data);
                states.prev = EVENTS.START;
            }

            if (states.update || (states.start && states.end)){
                // call update if updating or if both starting and stopping
                this.emit(EVENTS.UPDATE, data);
                states.prev = EVENTS.UPDATE;
            }
            else if (states.prev !== EVENTS.UPDATE && states.start && !states.end){
                // call start if all have started
                this.emit(EVENTS.START, data);
                states.prev = EVENTS.START;
            }
            else if (startCounter === 0 && states.prev !== EVENTS.START && states.end && !states.start){
                // call end if all have ended
                this.emit(EVENTS.END, data);
                states.prev = EVENTS.END;
            }
            else if (states.prev !== EVENTS.UPDATE && states.set){
                this.emit(EVENTS.SET, data);
                states.prev = EVENTS.SET;
            }

            // reset
            states.start = false;
            states.update = false;
            states.end = false;
            states.set = false;
        }

        var cache;
        function delay(data){
            cache = data;
            hasReceived = true;

            if (!hasSentLock) {
                this.emit('lockBelow');
                hasSentLock = true;
            }

            if (!locked && hasTicked){
                resolve.call(self, data);
            }
        }

        tick.on('tick', function(){
            hasTicked = true;
            if (!locked && hasReceived) {
                resolve.call(self, cache);
            }
        });

        tick.on('end tick', function(){
            hasTicked = false;
            hasReceived = false;
        });

        this._eventInput.on(EVENTS.SET, function(data){
            if (triggers && triggers.set) data = triggers.set(data);
            states.set = true;
            delay.call(self, data);
        });

        this._eventInput.on(EVENTS.START, function(data){
            if (triggers && triggers.start) data = triggers.start(data);
            states.start = true;
            startCounter++;
            delay.call(self, data);
        });

        this._eventInput.on(EVENTS.END, function(data){
            if (triggers && triggers.end) data = triggers.end(data);
            states.end = true;
            startCounter--;
            delay.call(self, data);
        });

        this._eventInput.on(EVENTS.UPDATE, function(data){
            if (triggers && triggers.update) data = triggers.update(data);
            states.update = true;
            delay.call(self, data);
        });

        this._eventInput.on('lockBelow', function(){
            lockCounter++;
            locked = true;
        });

        this._eventInput.on('unlockBelow', function(){
            lockCounter--;
            if (lockCounter === 0){
                locked = false;
            }
        });
    }

    Stream.prototype = Object.create(StreamContract.prototype);
    Stream.prototype.constructor = Stream;

    Stream.prototype.subscribe = function(source){
        var success = EventHandler.prototype.subscribe.apply(this._eventInput, arguments);
        if (success) {
            this._numSources++;
            if (this._numSources === 2) createResolveStrategy.call(this, this._triggers);
            if (source._isActive) {
                this.trigger('start', source.get());
            }
        }

        return success;
    };

    Stream.prototype.unsubscribe = function(source){
        if (!source){
            for (var i = 0; i < this._eventInput.upstream.length; i++){
                var source = this._eventInput.upstream[i]
                this.unsubscribe(source)
            }
            return true;
        }

        var success = EventHandler.prototype.unsubscribe.apply(this._eventInput, arguments);
        if (success) {
            if (source._isActive) {
                this.trigger('end', source.get());
            }
            this._numSources--;
            if (this._numSources === 1) createSimpleStrategy.call(this, this._triggers);
        }

        return success;
    };

    Stream.prototype.trigger = function(type, handler){
        EventHandler.prototype.trigger.apply(this._eventInput, arguments);
    };

    module.exports = Stream;
});
