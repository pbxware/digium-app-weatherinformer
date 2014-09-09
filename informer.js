// Lets include the app (for standard settings option):
var app = require('app');

// And initialize it as required:
app.init();

// Our select tool input:
var SelectInput = require('SelectInput').SelectInput;

// Include some utilities:
var util = require('util');

// Screen instance:
var screen = require('screen');

// Idle window reference;
var wnd = null;

// On foreground event call:
var onforeground_called = false;

// On foreground event call to display error:
var onforeground_error = false;

// If app is already running it has true value:
var instantiated = false;

// Default city for "no-config" app:
var DEF_CITY_ID = 27612;

// Screen update interval (for 4 different forecasts)
var DEF_FORECAST_SCREEN_INT = 15000;

// Server request interval (to update weather data):
var DEF_FORECAST_UPDATE_INT = 3600000;

// Server request interval (to update weather data in case of error):
var DEF_FORECAST_ERROR_UPDATE_INT = 60000;

// App runtime configuration:
var config = {};

// Runtime gathered weather data:
var weather_data = {};

// Which forecast should display next refresh;
var forecast_display = 0;

// Count of available forecasts:
var forecasts_count = 0;

// Timer id of weather update request timeout
var timeout_request = null;

// Timer id of forecast display refresh timeout
var timeout_refresh = null;

// Extended time of day explanations:
var tod_extended = {
	'0': ['Утром', 'Днём', 'Вечером'],
	'1': ['Днём', 'Вечером', 'Ночью'],
	'2': ['Вечером', 'Ночью', 'Завтра утром'],
	'3': ['Ночью', 'Завтра утром', 'Завтра днём']
};

// Weekday russian shortcuts (Gismeteo format):
var week_days = {
	'1':'Вс',
	'2':'Пн',
	'3':'Вт',
	'4':'Ср',
	'5':'Чт',
	'6':'Пт',
	'7':'Сб'
};

// Gismeteo wind direction map:
var wind_dir = {
	'0':'C',
	'1':'СВ',
	'2':'В',
	'3':'ЮВ',
	'4':'Ю',
	'5':'ЮЗ',
	'6':'З',
	'7':'СЗ'
};

// Decode CP1251 (name of city):
function decode1251 (str) {
	var i, result = '', l = str.length, cc;

	for (i = 0; i < l; i++) {
		cc = str.charCodeAt(i);

		if ('\r' == str[i]) continue;

		if (cc < 192) {
			if (168 == cc)
				result += 'Ё';
			else if (184 == cc)
				result += 'ё';
			else
				result += String.fromCharCode(cc);
		}
		else
			result += String.fromCharCode(cc + 848);
	}

	return result;
}

// Just a little workaround for IDE:
function endForegroundMonitor () {
	onforeground_called	= false;
	onforeground_error		= false;
}

// Show window for selecting user-defined city:
function showFormCities () {
	if (!onforeground_called) return;

	digium.event.stopObserving({'eventName'	: 'digium.app.background'});

	digium.event.observe({
		'eventName'	: 'digium.app.background',
		'callback'	: function () {
			endForegroundMonitor();
			digium.event.stopObserving({'eventName'	: 'digium.app.background'});
		}
	});

	screen.clear();

	var i, select_options = [];

	for (i in cities) {
		if (cities.hasOwnProperty(i))
			select_options.push({'value':i,'display':cities[i]});
	}

	var select = new SelectInput({
		'options':select_options,
		'width':window.w - 120,
		'title':'Выберите город из списка',
		'x':100,
		'y':20+Text.LINE_HEIGHT,
		'initialValue':config['CITY_ID'].toString()
	});

	select.onFocus = function(){return true};

	window.add(screen.setTitleText({'title' : 'Настройка местоположения'}));
	window.add(new Text(20, 20+Text.LINE_HEIGHT, 70, Text.LINE_HEIGHT, 'Ваш город:'));
	window.add(select.textWidget);

	select.takeFocus();

	select.textWidget.setSoftkey(4, 'Назад', showAppWindow);

	select.textWidget.setSoftkey(1, 'Готово', function(){
		config['CITY_ID'] = parseInt(select.value);
		confirmUserCity();
		updateWeatherData();
		digium.background();
	});
}

// Saving user's choice:
function confirmUserCity () {
	try {
		digium.writeFile(
			'nv',
			'settings.json',
			JSON.stringify({'CITY_ID':config['CITY_ID']})
		);
	}
	catch(e) {}
}

// Getting app-level configuration:
function getApplicationConfig () {
	return util.defaults(app.getConfig().settings, {
		'CITY_ID':DEF_CITY_ID,
		'FORECAST_SCREEN_INT':DEF_FORECAST_SCREEN_INT,
		'FORECAST_UPDATE_INT':DEF_FORECAST_UPDATE_INT
	});
}

// Getting user-level configuration:
function getLocalConfig () {
	var result;

	try {
		var configFile = digium.readFile('nv', 'settings.json');

		result = JSON.parse(configFile);
	} catch (e) {
		result = {};
	}

	return result;
}

// Function-helper for parsing single node attrs:
function getMappedAttributes (node, map) {
	var i, result = {};

	for (i in map) {
		if (map.hasOwnProperty(i))
			result[map[i]] = node.getAttribute(i);
	}

	return result;
}

// Parse xml weather data to object:
function parseWeatherData (src) {
	var data = {}, nodes, node, l, i, subnode;

	var parser = new DOMParser();

	try {
		var doc = parser.parseFromString(src, 'application/xml');

		nodes = doc.getElementsByTagName('TOWN');

		data.city = decode1251(unescape(nodes[0].getAttribute('sname'))).replace('+', ' ');

		nodes = doc.getElementsByTagName('FORECAST');

		l = nodes.length; i = 0;

		forecasts_count = l;

		node = nodes[0];

		data.day = node.getAttribute('day');
		data.month = node.getAttribute('month');
		data.weekday = node.getAttribute('weekday');
		data.tod = node.getAttribute('tod');
		data.forecasts = {};

		var forecast, tmp;

		do {
			forecast = {};

			subnode = node.getElementsByTagName('PHENOMENA')[0];

			forecast = util.defaults(forecast, getMappedAttributes(subnode, {
				'cloudiness':'clouds',
				'precipitation':'precip',
				'rpower':'rpower',
				'spower':'spower'
			}));

			subnode = node.getElementsByTagName('PRESSURE')[0];

			tmp =  getMappedAttributes(subnode, {
				'min':'min',
				'max':'max'
			});

			forecast.press = tmp.min + '-' + tmp.max;

			subnode = node.getElementsByTagName('TEMPERATURE')[0];

			tmp =  getMappedAttributes(subnode, {
				'min':'min',
				'max':'max'
			});

			forecast.temp = parseInt((parseInt(tmp.min) + parseInt(tmp.max)) / 2);

			subnode = node.getElementsByTagName('WIND')[0];

			tmp =  getMappedAttributes(subnode, {
				'min':'min',
				'max':'max',
				'direction':'wdir'
			});

			forecast.wspeed = parseInt((parseInt(tmp.min) + parseInt(tmp.max)) / 2);
			forecast.wdir = tmp.wdir;

			subnode = node.getElementsByTagName('RELWET')[0];

			forecast = util.defaults(forecast, getMappedAttributes(subnode, {
				'max':'hum'
			}));

			data.forecasts[i] = forecast;

			node = nodes[++i];
		}
		while (i < l);
	}
	catch(e) {
		data = {error:true};
	}

	return data;
}

// Currently disabled (show error message in window of the app)
/*function reportError (info) {
	endForegroundMonitor();

	onforeground_error = true;

	digium.foreground();

	screen.clear();

	window.add(new Text(0, 0, window.w,Text.LINE_HEIGHT * 2, info.type + ': ' + info.description));

	digium.event.stopObserving({'eventName'	: 'digium.app.background'});

	digium.event.observe({
		'eventName'	: 'digium.app.background',
		'callback'	: function () {
			endForegroundMonitor();
			digium.event.stopObserving({'eventName'	: 'digium.app.background'});
		}
	});
}*/

// Get current no of forecast to display:
function getForecastToDisplay () {
	if (forecast_display > (forecasts_count - 1) )
		return forecast_display = 0;
	else
		return forecast_display++;
}

// Get labels values (with updated data):
function getUpdatedLabels (forecast_no) {
	var result = {}, time = '';

	var forecast = weather_data.forecasts[forecast_no];

	if (!forecast_no) time = 'Сейчас';
	else time = tod_extended[weather_data.tod][forecast_no - 1];

	result.temp = time + ' ' + forecast.temp + ' °C';
	result.press = forecast.press + ' мм рт. ст.';
	result.hum = 'Влажность ' + forecast.hum + '%';
	result.wind = 'Ветер ' + forecast.wspeed + ' м/с ' + wind_dir[forecast.wdir];

	return result;
}

// "Humanize" Gismeteo phenomena:
function getPhenomenaObj (forecast, nt) {
	// Default state of the phenomena part:
	var result = {icon:'unknown',status:'Нет данных'};

	if ((1 == forecast.spower) &&
		((8 == forecast.precip) || (9 == forecast.precip))) {

		result.icon = 'storm';
		result.status = 'Грозы';
	}
	else if (5 == forecast.precip) {
		result.icon = 'rainfall';
		result.status = 'Ливень';
	}
	else if (4 == forecast.precip) {
		result.icon = 'rain';
		result.status = 'Дождь';
	}
	else if ((6 == forecast.precip) || (7 == forecast.precip)) {
		result.icon = 'snow';
		result.status = 'Снег';
	}
	else if (3 == forecast.clouds) {
		result.icon = 'mostlycloudy';
		result.status = 'Пасмурно';
	}
	else if (2 == forecast.clouds) {
		result.icon = 'cloudy';
		result.status = 'Облачно';
	}
	else if ((1 == forecast.clouds) && (10 == forecast.precip)) {
		if (nt)
			result.icon = 'nt_mostlyclear';
		else
			result.icon = 'mostlyclear';

		result.status = 'Перем. облач.';
	}
	else if ((0 == forecast.clouds) && (10 == forecast.precip)) {
		if (nt)
			result.icon = 'nt_clear';
		else
			result.icon = 'clear';

		result.status = 'Ясно';
	}

	return result;
}

// Refresh widget contents on the idle display:
function idleRefresh () {
	var labels, fno, f, nt = false;

	fno = getForecastToDisplay();
	labels = getUpdatedLabels(fno);

	f = weather_data.forecasts[fno];

	if (weather_data.tod == 0 && fno == 0)
		nt = true;
	else if (weather_data.tod == 1 && fno == 3)
		nt = true;
	else if (weather_data.tod == 2 && fno == 2)
		nt = true;
	else if (weather_data.tod == 3 && fno == 1)
		nt = true;

	var phen = getPhenomenaObj(f, nt);

	wnd[0] = new Image('app', phen.icon + '.gif', 15, 3 * Text.LINE_HEIGHT, 45, 32);
	wnd[2].label = labels.temp;
	wnd[3].label = phen.status;
	wnd[4].label = labels.press;
	wnd[5].label = labels.hum;
	wnd[6].label = labels.wind;

	clearTimeout(timeout_refresh);

	timeout_refresh = setTimeout(function(){
		idleRefresh();
	}, config['FORECAST_SCREEN_INT']);
}

// Function to finalize "get weather request"
function getWeatherCb (data) {
	if (data.hasOwnProperty('error') && data.error) {
		wnd[1].label = 'Обновление данных...';
		setTimeout(updateWeatherData, DEF_FORECAST_ERROR_UPDATE_INT);
	}
	else {
		weather_data = data; // overwrite previous data

		wnd[1].label = data.city;

		wnd[7].label = week_days[data.weekday] + ' ' + data.day + '.' + data.month;

		idleRefresh();
	}
}

// Get weather data from Gismeteo:
function getWeather (cb) {
	wnd[1].label = 'Обновление данных...';

	var uri = 'http://informer.gismeteo.ru/xml/' + config['CITY_ID'] + '.xml';

	var request = new NetRequest();

	request.open('GET', uri, true);

	request.onreadystatechange = function () {
		if (4 == request.readyState) {
			if (200 == request.status)
				cb(parseWeatherData(request.responseText));
			else {
				setTimeout(updateWeatherData, DEF_FORECAST_ERROR_UPDATE_INT);
			}
		}
	};

	request.send();

	clearTimeout(timeout_request);

	timeout_request = setTimeout(
		updateWeatherData,
		config['FORECAST_UPDATE_INT']
	);
}

// Function for usage in setTimeout func:
function updateWeatherData () {
	getWeather(getWeatherCb);
}

// Idle window initialization and reference store;
function initialize () {
	var cursor = 0, label;

	wnd = digium.app.idleWindow;

	if ('D70' != digium.phoneModel)
		wnd.hideTopBar = true;

	wnd.hideBottomBar = true;

	wnd.add(new Image('app', 'unknown.gif', 15, 3 * Text.LINE_HEIGHT, 45, 32));

	for (var i = 0; i < 7; i++) {
		if (0 == i)
			label = new Text(0, Text.LINE_HEIGHT * cursor++, wnd.w, Text.LINE_HEIGHT);
		else if (2 == i)
			label = new Text(0, 2 * Text.LINE_HEIGHT, 65, Text.LINE_HEIGHT, 'Нет данных');
		else if (6 == i)
			label = new Text(0, Text.LINE_HEIGHT, 65, Text.LINE_HEIGHT);
		else
			label = new Text(65, Text.LINE_HEIGHT * cursor++, wnd.w - 65, Text.LINE_HEIGHT);

		label.align(Widget.CENTER);

		wnd.add(label);
	}

	digium.app.exitAfterBackground = false;

	digium.event.observe({
		'eventName'	: 'digium.app.start',
		'callback'	: function () {
			setTimeout(function(){instantiated = true;}, 1000);
		}
	});

	digium.event.observe({
		'eventName'	: 'digium.app.idle_screen_show',
		'callback'	: function () {
			if (digium.app.idleWindowShown)
				idleRefresh();
		}
	});

	digium.event.observe({
		'eventName'	: 'digium.app.foreground',
		'callback'	: function () {
			// Stopping recursive call when error message box
			// should be shown by calling digium.foreground()
			if (onforeground_called) return ;

			onforeground_called = true;

			if (!instantiated) {
				// bring app to idle on the first launch:
				digium.background();
				instantiated = true;
				endForegroundMonitor();
			}
			else {
				// Show select options list: 1. setting up; 2. exit widget
				// showFormCities();
				showAppWindow();
			}
		}
	});
}

function showAppWindow () {
	if (!onforeground_called) return;

	digium.event.stopObserving({'eventName'	: 'digium.app.background'});

	digium.event.observe({
		'eventName'	: 'digium.app.background',
		'callback'	: function () {
			endForegroundMonitor();
			digium.event.stopObserving({'eventName'	: 'digium.app.background'});
		}
	});

	screen.clear();

	window.add(screen.setTitleText({'title' : 'Погода'}));

	try {
		window.add(new Text(4, 20, window.w, Text.LINE_HEIGHT, 'Выберите опцию:'));

		var menuObj = new List(4, 20 + Text.LINE_HEIGHT, window.w, window.h);

		menuObj.setProp('cols', 2).setProp('rows', 2);

		menuObj.set(0, 0, '1.');
		menuObj.set(0, 1, 'Выбрать город');
		menuObj.set(1, 0, '2.');
		menuObj.set(1, 1, 'Закрыть виджет');

		menuObj.setColumnWidths(15, 0);
		menuObj.select(0);

		menuObj.onFocus = function() {return true; };

		var selected = function() {
			if (0 == menuObj.selected)
				showFormCities();
			else {
				digium.app.exitAfterBackground = true;
				digium.background();
			}
		};

		menuObj.onkey1 = function(){ menuObj.select(0); selected(); };
		menuObj.onkey2 = function(){ menuObj.select(1); selected(); };

		menuObj.onkeyselect = selected;

		menuObj.setSoftkey(1, 'OK', selected);

		window.add(menuObj);

		menuObj.takeFocus();
	}
	catch(e) {
		window.add(new Text(0, 20, window.w, Text.LINE_HEIGHT, e.message));
	}
}

// Get summary configuration data with user-level priority:
config = util.defaults(getLocalConfig(), getApplicationConfig());

// Initialize:
initialize();

// Start app main cycle:
updateWeatherData();