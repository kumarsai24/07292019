/**
 * Company           Explore Consulting
 * Copyright         2016 Explore Consulting, LLC
 * Description       Handles a variety of WSI business rules performed upon save of a Purchase Order
 * Functional Spec https://docs.google.com/document/d/1_ZziW47kdT3SSswSgf1zsO4-1PwDpnEjKHBdUKh1Q1c
 **/
///<reference path="typings/browser.d.ts"/>
//region Type Declarations
/**
 *Custom list 'WS PO Line Change Types' on DE1. Represents the type of change that happened to line items.
 */
var LineChange;
(function(LineChange) {
	/**
	 * Add Items
	 */
	LineChange[LineChange["AI"] = 1] = "AI";
	/**
	 * Delete Items
	 */
	LineChange[LineChange["DI"] = 2] = "DI";
	/**
	 *Price Change
	 */
	LineChange[LineChange["PC"] = 3] = "PC";
	/**
	 * Quantity Decrease
	 */
	LineChange[LineChange["QD"] = 4] = "QD";
	/**
	 * Quantity Increase
	 */
	LineChange[LineChange["QI"] = 5] = "QI";
	/**
	 * HTS Change
	 */
	LineChange[LineChange["HS"] = 6] = "HS";
})(LineChange || (LineChange = {}));
//endregion types
/**
 * fields used with nsdal - all the fields on the PO object we're interested in working with. should mirror the interface
 * @type {string[]}
 */
var poFields = ['custbody_override_ship_window_end_date', 'custbody_ship_window_end_date', 'shipdate', 'duedate',
	'custbody_public_eta_date', 'custbody_override_eta_date', 'custbody_transit_time', 'tranid', 'class',
	'statusRef', 'custbody_version', 'custbody_revision_date', 'externalid', 'custbody_po_trading_partners',
	'custbody_po_agent', 'entity', 'custbody_freight_lane', 'custbody_exported_to_tibco', 'lastmodifieddate',
	'custbody_resend_to_tibco', 'custbody_po_lading_port', 'custbody_destination', 'custbody_buyer',
	'custbody_total_cost', 'custbody_total_quantity'
];
var lineItemFields = ['item', 'amount', 'custcol_master_case_quantity', 'custcol_distribution_lot_quantity',
	'custcol_po_line_change_type', 'custcol_po_origin_country', 'custcol_hts_assignment', 'custcol_supplier',
	'quantity', 'isclosed', 'quantityreceived', 'id', 'line', 'linenumber', 'rate', 'custcol_indefinite_hts',
	'custcol_original_quantity', 'custcol_item_source', 'custcol_shipping_milestone_history',
	'custcol_us_retail_price', 'custcol_hts_details'
];
var EC;
(function(EC) {
	EC.enableLazySearch();
	/**
	 * provides a single point of contact for script parameters (script configuration data)
	 * @returns the script parameters as an object
	 */
	function getConfig() {
		var ctx = nlapiGetContext();
		return {
			// email body
			emailTemplate: ctx.getSetting('SCRIPT', 'custscript_po_email_template'),
			// to whom the email template should be sent
			emailCClist: ctx.getSetting('SCRIPT', 'custscript_po_email_cc'),
			emailFrom: ctx.getSetting('SCRIPT', 'custscript_po_email_from'),
			currentUser: ctx.getUser(),
			defaultHtsCountryCode: ctx.getSetting('SCRIPT', 'custscript_po_default_hts_country')
		};
	}
	/**
	 * Configuration from NS script parameters
	 */
	EC.config = getConfig();
	/**
	 * sets delivery dates on purchase orders if they are NOT specified as 'override' by the user
	 * @param type script event type (e.g. 'create', 'edit')
	 */
	function setDeliveryDates(type) {
		var origEtaDate = EC.po.duedate;
		Log.d('orig ETA date', origEtaDate);
		if (!EC.po.custbody_override_ship_window_end_date && EC.po.shipdate) {
			EC.po.custbody_ship_window_end_date = EC.po.shipdate.clone().add('7', 'days');
		}
		// default ETA date is ship end date plus transit time
		if (!EC.po.custbody_override_eta_date && EC.po.custbody_ship_window_end_date) {
			EC.po.duedate = EC.po.custbody_ship_window_end_date.clone().add(EC.po.custbody_transit_time, 'days');
		}
		var etaDateChanged = EC.po.duedate && !EC.po.duedate.isSame(origEtaDate);
		if (type == 'create' || etaDateChanged) {
			EC.po.custbody_public_eta_date = EC.po.duedate;
		}
		Log.d('dates after processing', _.pick(EC.po, ['duedate', 'custbody_public_eta_date', 'custbody_ship_window_end_date', 'shipdate']));
	}
	EC.setDeliveryDates = setDeliveryDates;
	/**
	 * Validates delivery dates AND sends an email if the dates fail validation
	 * @param shipStartDate first date to validate
	 * @param shipEndDate second date to validate
	 */
	function validateDeliveryDates(shipStartDate, shipEndDate) {
		// workaround for xedit?
		if (!shipStartDate && !shipEndDate) {
			Log.d('short circuit', 'shipStartDate or shipEndDate are falsey');
			return;
		}
		var now = moment();
		var valid = shipStartDate.isAfter(now) || shipEndDate.isAfter(now);
		if (!valid) {
			var emailBody = _.template(EC.config.emailTemplate)(EC.po);
			Log.d("sending mail  to " + EC.po.custbody_buyer, EC.config);
			// NS can't handle spaces - can't believe they don't trim
			var cc = _.map(EC.config.emailCClist.split(','), _.trim);
//			nlapiSendEmail(EC.config.emailFrom, EC.po.custbody_buyer, 'Purchase Order Delivery Dates Invalid', emailBody, cc);
		}
		return valid;
	}
	EC.validateDeliveryDates = validateDeliveryDates;
	/**
	 * Generates a purchase order number by combining tranid, brand and fixed values
	 * @returns {string} the generated PO number
	 */
	function generatePOnumber() {
		var brand = EC.po.getFieldText('class');
		return "" + EC.po.tranid + brand + "R";
	}
	EC.generatePOnumber = generatePOnumber;
	/**
	 * conditionally updates the current PO version and last revision date based on transaction status
	 */
	function setPOversion() {
		var shouldUpdate = _.includes(['pendingReceipt', 'partiallyReceived',
			'closed', 'pendingBillPartReceived'
		], EC.po.statusRef);
		if (shouldUpdate) {
			EC.po.custbody_version++;
			EC.po.custbody_revision_date = moment();
			Log.d('updated PO version', _.pick(EC.po, 'custbody_version', 'custbody_revision_date'));
		}
	}
	EC.setPOversion = setPOversion;
	/**
	 * Sets the distribution lot quantity and master case quantity to 1 if they are invalid or < 1
	 */
	function setMasterCaseAndLot() {
		_.each(EC.po.item, function(i) {
			var dlq = i.custcol_distribution_lot_quantity;
			if (_.isNumber(dlq) && dlq < 1) {
				i.custcol_distribution_lot_quantity = 1;
			}
			var mcq = i.custcol_master_case_quantity;
			if (_.isNumber(mcq) && mcq < 1) {
				i.custcol_distribution_lot_quantity = 1;
			}
		});
	}
	EC.setMasterCaseAndLot = setMasterCaseAndLot;
	/**
	 * Prevents users from manually checking the 'closed' checkbox on a line item and persisting the result.
	 * This quietly reverts that selection and resets the quantity
	 */
	function processClosedLines() {
		_.each(EC.po.item, function(i) {
			Log.d('line', i);
			if (i.isclosed === true) {
				Log.d('closed line', "setting new quantity (" + i.quantityreceived + ")");
				i.quantity = i.quantityreceived;
			}
		});
	}
	EC.processClosedLines = processClosedLines;
	/**
	 * builds a CSV list of trading partner vendors based on business rules and saves to the PO
	 */
	function setTradingPartner() {
		var tradingPartners = [];
		Log.d('relevant props', _.pick(EC.po, 'custbody_po_agent', 'custbody_freight_lane', 'entity'));
		if (!EC.po.custbody_po_agent) {
			var vendorNumber = nlapiLookupField('vendor', EC.po.entity, 'entityid');
			tradingPartners.push(vendorNumber);
		} else {
			var agentNumber = nlapiLookupField('vendor', EC.po.custbody_po_agent, 'entityid');
			if (agentNumber && (agentNumber != '30000') && (agentNumber != '30001')) {
				tradingPartners.push(agentNumber);
			}
		}
		if (EC.po.custbody_freight_lane) {
			// always add logistics partner if it exists
			var entity = EC.createSearch('customrecord_freight_lane', [
				['internalid', 'is', EC.po.custbody_freight_lane]
			], [
				['entityid', null, 'custrecord_freight_logistics_provider']
			]).nsSearchResult2obj().first();
			if (entity && entity.entityid) {
				tradingPartners.push(entity.entityid);
			} else {
				Log.a('cannot assign freight lane logistics provider', "custbody_freight_lane:" + EC.po.custbody_freight_lane + ", " + JSON.stringify(entity));
			}
		}
		// always add these two fixed values to the end
		tradingPartners.push(26372, 58205);
		EC.po.custbody_po_trading_partners = tradingPartners.join(',');
	}
	EC.setTradingPartner = setTradingPartner;
	/**
	 * Encapsulates logic determining if we need to proceed with new/old record comparison for TIBO resend flagging
	 * @param type script execution type
	 * @returns {boolean} true if we don't need to proceed with record comparison
	 */
	function skipTibcoResend(type) {
		var isEdit = _.includes(['edit', 'xedit'], type);
		var hasCorrectStatus = _.includes(['pendingApproval', 'pendingReceipt', 'partiallyReceived', 'pendingBillPartReceived',
			'pendingSupervisorApproval'
		], EC.po.statusRef);
		var isExported = EC.po.custbody_exported_to_tibco === true;
		Log.d('criteria', {
			isEdit: isEdit,
			hasCorrectStatus: hasCorrectStatus,
			isExported: isExported
		});
		// we can skip tibco resend if we're not in edit mode or the transaction isn't in one of the specified
		// status codes or if the record has not been previously exported.
		return !isEdit || !hasCorrectStatus || !isExported;
	}
	/**
	 * Checks body fields for changes
	 * @returns {boolean} if specific body fields have changed value between the old and new records returns true
	 */
	function relevantBodyFieldsChanged() {
		var bodyFields = ['custbody_buyer', 'custbody_destination', 'shipdate', 'custbody_ship_window_end_date',
			'duedate', 'custbody_po_agent', 'custbody_po_lading_port', 'custbody_po_ship_method', 'custbody_po_payment_method',
			'custbody_po_payment_terms', 'custbody_freight_terms', 'custbody_vendor_notes'
		];
		var oldRecord = nsdal.fromRecord(nlapiGetOldRecord(), bodyFields);
		// note, the new record returns empty string "" for unset fields, whereas old record shows
		// these values as null. So we transform the old record to coalesce to empty string for the nulls
		oldRecord = _.mapValues(oldRecord, function(value) {
			return (value === null) ? '' : value;
		});
		var oldSerialized = JSON.stringify(oldRecord);
		Log.d('old record', oldSerialized);
		var newRecord = nsdal.fromRecord(nlapiGetNewRecord(), bodyFields);
		newRecord = _.mapValues(newRecord, function(value) {
			return (value === null) ? '' : value;
		});
		var newSerialized = JSON.stringify(newRecord);
		Log.d('new record', newSerialized);
		Log.d('LAST MODIFIED', "old record:" + oldRecord.getFieldValue('lastmodifieddate') + ", new record:\n         " + newRecord.getFieldValue('lastmodifieddate') + " ");
		// these don't compare naturally because (I think) of the strict compare between
		// moment instances. So instead let's just compare the JSON serialized version
		// of each object
		return !_.isEqual(oldSerialized, newSerialized);
	}
	/**
	 * Marks the PO as needing re-exporting to TIBCO if it meets certain business requirements
	 * @param type script execution type
	 */
	function retriggerPurchaseOrderExport(type) {
		if (skipTibcoResend(type)) {
			Log.d('not flagging for resend', 'retriggering purchase order export not necessary due to skipTibcoResend()');
			return;
		}
		var oldRecord = nsdal.fromRecord(nlapiGetOldRecord(), poFields);
		oldRecord.withSublist('item', lineItemFields);
		var lineChanged = new LineChangeHandler(EC.po, oldRecord.item, EC.po.item).processLines();
		if (lineChanged) {
			Log.d('resend to TIBCO', 'flagging to resend to TIBCO because item line(s) changed');
			EC.po.custbody_resend_to_tibco = true;
		}
		if (!EC.po.custbody_resend_to_tibco && relevantBodyFieldsChanged()) {
			Log.d('resend to TIBCO', 'flagging to resend to TIBCO because body fields changed');
			EC.po.custbody_resend_to_tibco = true;
		}
		Log.d('oldRecord lines', oldRecord.item);
		Log.d('newRecord lines', EC.po.item);
	}
	EC.retriggerPurchaseOrderExport = retriggerPurchaseOrderExport;
	/**
	 * Search for harmonized tariff info for the given items based on where the item is coming from and where it's going.
	 * @param items list of item internal ids to search
	 * @param destination internal id of the WSI Destination record representing the country the item imports to
	 * @returns {Array} search results, empty array if none found
	 */
	function findHTSforItems(items, itemSources, destination) {
		// where the item is importing TO
		var importCountry = nlapiLookupField('customrecord_destination', destination, 'custrecord_destination_hts_country');
		if (!importCountry)
			return []; // no use searching if no destination country
		// try and find HTS records for each item
		var results = EC.createSearch('customrecord_hts_assignment', [
			['custrecord_hts_assignment_item', 'anyof', _.map(items, 'item')], 'and', ['custrecord_hts_assignment_supplier', 'anyof', _.map(items, 'custcol_supplier')], 'AND', ['custrecord_hts_assignment_origin_country', 'anyof',
				_.map(itemSources, 'custrecord_item_source_country')
			], 'AND', ['custrecord_hts_assignment_import_country', 'anyof', [importCountry, EC.config.defaultHtsCountryCode]]
		], [
			['internalid'],
			['custrecord_hts_assignment_item'],
			['custrecord_hts_assignment_supplier'],
			['custrecord_hts_assignment_origin_country'],
			['custrecord_hts_assignment_description'],
			['custrecord_hts_assignment_import_country'],
			['lastmodified']
		]).nsSearchResult2obj().toArray();

		// provide results indexed by vendor + item + origin country + import country
		return _.groupBy(results, function(result) {
			return (
				result.custrecord_hts_assignment_supplier + '-' +
				result.custrecord_hts_assignment_item + '-' +
				result.custrecord_hts_assignment_origin_country + '-' +
				result.custrecord_hts_assignment_import_country
			);
		});
	}
	EC.findHTSforItems = findHTSforItems;
	function getHtsDetails(ids) {
		Log.d('HTS ids', ids);
		ids = _.without(ids, '');
		Log.d('HTS ids filtered', ids);

		if (ids instanceof Array && ids.length) {
			var results = EC.createSearch('customrecord_hts_component',
				[['custrecord_hts_component_assignment', 'anyof', ids]],
				[
					['internalid', null, 'custrecord_hts_component_assignment'],
					['name'],
					['custrecord_hts_component_duty_rate']
				]).nsSearchResult2obj().toArray();

			var resultsByAssignment = _.groupBy(results, 'internalid');
			_.each(resultsByAssignment, function(assignment) {
				_.each(assignment, function(component) {
					component.rate = parseFloat(component.custrecord_hts_component_duty_rate) || 0;
					delete component.custrecord_hts_component_duty_rate;
					delete component.internalid;
				});
			});
		
			return resultsByAssignment;
		}
	}
	EC.getHtsDetails = getHtsDetails;
	/**
	 * Tries to find HTS values needed for each item in the PO and sets them (HTS code, duty rate, etc.)
	 * It will search by specific import destination and fall back to US (a default) for a second search
	 * Then any HTS info found is applied to the PO lines. Lines for which no records were found are not
	 * touched.
	 */
	function setHTSvalues() {
		// item sources represent where the item is coming FROM (amongst other things)
		var itemSources = EC.createSearch('customrecord_item_source', [
			['internalid', 'anyof', _.map(EC.po.item, 'custcol_item_source')]
		], [
			['custrecord_item_source_country'],
			['custrecord_item_source_item']
		]).nsSearchResult2obj().toArray();
		Log.d('item sources', itemSources);

		var countryByItem = _.groupBy(itemSources, 'custrecord_item_source_item');

		// first query hts assignments for all items with the given destination
		var htsRecords = EC.findHTSforItems(EC.po.item, itemSources, EC.po.custbody_destination);
		var importCountry = nlapiLookupField('customrecord_destination', EC.po.custbody_destination, 'custrecord_destination_hts_country');

		_.each(EC.po.item, function(line) {
			var keyBase = line.custcol_supplier + '-' + line.item + '-' + countryByItem[line.item][0].custrecord_item_source_country + '-';

			//find HTS assignments for this item and the actual import destination country
			var htsInfos = htsRecords[keyBase + importCountry];
			if (!htsInfos || !htsInfos.length) {
				htsInfos = htsRecords[keyBase + EC.config.defaultHtsCountryCode];
			}

			// if we found more than one result, we're indeterminate, reset if we find none
			if (!htsInfos || htsInfos.length == 0) {
				Log.d("found no HTS assignment matches for item " + line.item, htsInfos);
				line.custcol_hts_assignment = null;
				line.custcol_hts_details = '[]';
			} else if (htsInfos.length > 1) {
				Log.d("found multiple HTS assignment matches for item " + line.item, htsInfos);
				line.custcol_indefinite_hts = true;
				line.custcol_hts_details = '[]';
			} else {
				Log.d("found " + htsInfos.length + " HTS assignments", htsInfos);
				// else we have zero or one - in the case of zero this map does nothing
				_.map(htsInfos, function(hts) {
					line.custcol_hts_assignment = hts.internalid;

					var htsDetails = EC.getHtsDetails([hts.internalid]);
					Log.d('hts details', htsDetails);

					line.custcol_hts_details = JSON.stringify(htsDetails[hts.internalid]);

					// the date the HTS Assignment record was last modified is used by other steps (HTS change detection)
					// in the script so preserve it here
					line._hts_assignment_last_modified = moment(nlapiStringToDate(hts.lastmodified));
					Log.d('set hts assignment on line', line);
				});
			}
		});
	}
	EC.setHTSvalues = setHTSvalues;
	/**
	 * creates shipping milestone records -
	 */
	function createShippingMilestones() {
		var history = EC.po.recmachcustrecord_sm_history_purchase_order;
		Log.d('history', history);
		_.map(EC.po.item, function(i) {
			var hist = _.find(history, {
				custrecord_sm_history_item: i.item
			});
			if (hist)
				Log.d('found existing shipping history record', hist);
			else {
				Log.d('creating new shipping history record');
				hist = history.addLine();
				hist.custrecord_sm_history_item = i.item;
			}
		});
	}
	EC.createShippingMilestones = createShippingMilestones;

	function missingShippingMilestoneHistories() {
		EC.po = nsdal.fromRecord(nlapiGetNewRecord(), poFields);
		EC.po.withSublist('item', lineItemFields);

		return _.some(EC.po.item, function(line) {
			return !line.custcol_shipping_milestone_history
		});
	};
	EC.missingShippingMilestoneHistories = missingShippingMilestoneHistories;

	function linkShippingMilestoneHistories() {
		// map items to histories
		var itemHistories = {};
		_.each(EC.po.recmachcustrecord_sm_history_purchase_order, function(history) {
			itemHistories[history.custrecord_sm_history_item] = history.id;
		});
		// set item histories from map
		_.each(EC.po.item, function(line) {
			if (!line.custcol_shipping_milestone_history) {
				line.custcol_shipping_milestone_history = itemHistories[line.item];
			}
		});
	}
	EC.linkShippingMilestoneHistories = linkShippingMilestoneHistories;

	/**
	 * sets original quantity on all added item lines
	 */
	function setOriginalQuantities() {
		_.each(EC.po.item, function(item) {
			// only set original quantity when lines are newly added
			if (!item.custcol_original_quantity) {
				item.custcol_original_quantity = item.quantity;
			}
		});
	};
	EC.setOriginalQuantities = setOriginalQuantities;

	function setTotals() {
		function getNumber(value) {
			return value ? Number(value) : 0;
		}

		var totalCost = 0;
		var totalQuantity = 0;

		_.each(EC.po.item, function(item) {
			totalCost += getNumber(item.amount);
			totalQuantity += getNumber(item.quantity);
		});

		EC.po.custbody_total_cost = totalCost;
		EC.po.custbody_total_quantity = totalQuantity;
	};
	EC.setTotals = setTotals;

	function setDefaultLineSupplier() {
		_.each(EC.po.item, function(item) {
			if (!item.custcol_supplier) {
				item.custcol_supplier = EC.po.entity;
			}
		});
	};
	EC.setDefaultLineSupplier = setDefaultLineSupplier;

  	function setRetailPrices() {
		var prices = {};
		var results = EC.createSearch('inventoryitem', [
			['internalid', 'anyof', _.map(EC.po.item, 'item')], 'and',
			['pricing.currency', 'is', '1' ], 'and',
			['pricing.pricelevel', 'is', '1' ]
        ], [
			['unitprice', null, 'pricing'],
			['internalid']
		]).nsSearchResult2obj()
        .toArray()
        .map(function(item) {
			prices[item.internalid] = item.unitprice;
        });

		_.each(EC.po.item, function(item) {
			item.custcol_us_retail_price = prices[item.item] || '0.00';
		});
	};
	EC.setRetailPrices = setRetailPrices;

	/**
	 * handler for BEFORE SUBMIT event (script entrypoint)
	 * @param type NS event type
	 * @param form the NS ui form
	 */
	function onBeforeSubmit(type, form) {
		if (type == 'delete') {
			return;
		}

		EC.po = nsdal.fromRecord(nlapiGetNewRecord(), poFields);
		EC.po.withSublist('item', lineItemFields);
		// enrich po object with the custom sublist for milestone history records
		EC.po.withSublist('recmachcustrecord_sm_history_purchase_order', ['custrecord_sm_history_item']);
		EC.setDeliveryDates(type);
		EC.validateDeliveryDates(EC.po.shipdate, EC.po.custbody_ship_window_end_date);
		if (type == 'edit' || type == 'xedit') {
			EC.po.externalid = EC.generatePOnumber();
		}
		EC.setPOversion();
		// prevent errors with xedit on PO approval list
		if (type != 'xedit') {
			EC.setTotals();
			EC.setDefaultLineSupplier();
			EC.setHTSvalues();
			EC.setTradingPartner();
			EC.setRetailPrices();
		}
		EC.processClosedLines();
		EC.setMasterCaseAndLot();
		EC.createShippingMilestones();
		EC.retriggerPurchaseOrderExport(type.toString());
		EC.setOriginalQuantities();
	}
	EC.onBeforeSubmit = onBeforeSubmit;
	/**
	 * handler for AFTER SUBMIT event
	 * @param type NS event type
	 */
	function onAfterSubmit(type) {
		if (type.toString() === 'create' || EC.missingShippingMilestoneHistories()) {
			EC.po = nsdal.loadObject('purchaseorder', nlapiGetRecordId(), poFields);
			EC.po.withSublist('item', lineItemFields);
			EC.po.withSublist('recmachcustrecord_sm_history_purchase_order', ['custrecord_sm_history_item', 'id']);
			// this is in onAfterSubmit because we need a tranid to be assigned in order
			// to generate the PO number
			EC.po.externalid = EC.generatePOnumber();
			//  setDeliveryDates(type)
			// validateDeliveryDates(po.duedate, po.custbody_ship_window_end_date)
			// po.externalid = generatePOnumber()

			EC.linkShippingMilestoneHistories();

			EC.po.save();
		}
	}
	EC.onAfterSubmit = onAfterSubmit;

	function hideVendorName(form) {
		nlapiGetLineItemField('item', 'vendorname').setDisplayType('hidden');
	}
	EC.hideVendorName = hideVendorName;

	/**
	 * handler for BEFORE LOAD event (script entrypoint)
	 * @param type
	 * @param form
	 */
	function onBeforeLoad(type, form) {
		if (type == 'create' || type == 'edit' || type == 'view') {
			EC.hideVendorName();
		}
	}
	EC.onBeforeLoad = onBeforeLoad;
})(EC || (EC = {}));
/**
 * Encapsulates the logic to detect line item field changes and update the Line Change Type field accordingly
 */
var LineChangeHandler = (function() {
	function LineChangeHandler(po, oldLines, newLines) {
		this.oldLines = oldLines;
		this.newLines = newLines;
		/**
		 * Determines the appropriate line change value for a given line by checking it against our rule functions
		 * The first check function that returns truthy returns the associated LineChange value
		 */
		this.checkConditions = _.cond([
			[this.isNew, _.constant(LineChange.AI)],
			[LineChangeHandler.isDeleted, _.constant(LineChange.DI)],
			[LineChangeHandler.decreasedQty, _.constant(LineChange.QD)],
			[LineChangeHandler.increasedQty, _.constant(LineChange.QI)],
			[LineChangeHandler.costChanged, _.constant(LineChange.PC)],
			[LineChangeHandler.htsChanged, _.constant(LineChange.HS)]
		]);
		this.po = po;
	}
	/**
	 * Line is new if its id cannot be found in the old record item array
	 * @param newLine line from the new record
	 * @returns the Add Items line change if the line is new, undefined otherwise
	 */
	LineChangeHandler.prototype.isNew = function(newLine) {
		return !_.some(this.oldLines, function(l) {
			return l.id === newLine.id;
		});
	};
	/**
	 * Has line b decreased relative to the old line?
	 * @param newLine new line
	 * @param oldLine
	 * @returns true if the new line has decreased its quantity
	 */
	LineChangeHandler.isDeleted = function(newLine, oldLine) {
		return _.isObject(oldLine) && (+oldLine.quantity > 0 && +newLine.quantity == 0);
	};
	/**
	 * Has line quantity increased relative to the old line?
	 * @param newLine new line
	 * @param oldLine
	 * @returns true if the new line has increased its quantity, false if it hasn't or there is no old line to compare
	 */
	LineChangeHandler.increasedQty = function(newLine, oldLine) {
		return _.isObject(oldLine) && (+newLine.quantity > +oldLine.quantity);
	};
	/**
	 * Has line quantity decreased relative to the old line?
	 * @param newLine new line
	 * @param oldLine
	 * @returns true if the new line has decreased its quantity, false if it hasn't or there is no old line to compare
	 */
	LineChangeHandler.decreasedQty = function(newLine, oldLine) {
		return _.isObject(oldLine) && (+newLine.quantity < +oldLine.quantity);
	};
	/**
	 * Has the cost changed between new line and old line?
	 * @param newLine
	 * @param oldLine
	 * @returns {boolean} true if there is a valid rate difference
	 */
	LineChangeHandler.costChanged = function(newLine, oldLine) {
		return _.isObject(oldLine) && newLine.rate !== oldLine.rate;
	};
	/**
	 * Have interesting HTS related fields changed between old and new lines?
	 * @param newLine
	 * @param oldLine
	 * @param POlastModified the date the PO was last modified (po.lastmodifieddate)
	 * @returns {boolean} true if there is a relevant change
	 */
	LineChangeHandler.htsChanged = function(newLine, oldLine, POlastModified) {
		if (!_.isObject(oldLine))
			return false;
		var assignmentChanged = newLine.custcol_hts_assignment !== oldLine.custcol_hts_assignment;
		var assignmentRecordIsNewer = false;
		// lines may not have a last modified date (i.e if they don't have HTS assignment at all)
		if (newLine._hts_assignment_last_modified && POlastModified) {
			assignmentRecordIsNewer = POlastModified.isBefore(newLine._hts_assignment_last_modified);
			Log.d('PO date vs HTS assignment', "PO date " + POlastModified.format() + ", \n            Assignment record last modified " + newLine._hts_assignment_last_modified.format());
		}
		Log.d('assignmentChanged', assignmentChanged);
		return assignmentChanged || assignmentRecordIsNewer;
	};
	/**
	 * Processes all lines of the new record, setting custcol_po_line_change_type as needed
	 * @returns true if any of the lines had a detected change
	 */
	LineChangeHandler.prototype.processLines = function() {
		var _this = this;
		return _.reduce(this.newLines, function(acc, newLine) {
			var oldLine = _.find(_this.oldLines, {
				id: newLine.id
			});
			// execute our rules in order, taking the first truthy result
			var theChange = _this.checkConditions(newLine, oldLine, _this.po.lastmodifieddate);
			if (theChange) {
				Log.d("detected line change", "line: " + newLine.id + ", change:" + LineChange[theChange]);
				newLine.custcol_po_line_change_type = theChange;
				return acc || true;
			} else
				return acc || false;
		}, false);
	};
	return LineChangeHandler;
}());
// withargs = false to avoid UNEXPECTED_ERROR due to the nlobjForm blowing up when JSON serialized
Log.AutoLogMethodEntryExit({
	withProfiling: true,
	withArgs: false
});
Log.includeCorrelationId = true;
